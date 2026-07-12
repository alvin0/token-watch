/**
 * Worker-threads entry point for the ingestion worker.
 *
 * Loads sql.js (wasm), opens/migrates the UsageStore, creates the PricingEngine
 * and AnalyticsService, then dispatches WorkerRequest messages from the host.
 *
 * This module MUST NOT import `vscode`.
 */

import { parentPort } from "worker_threads";
import { join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import initSqlJs from "sql.js";
import { UsageStore } from "./store/UsageStore.js";
import { PricingEngine } from "./pricing.js";
import { AnalyticsService } from "./analytics.js";
import { mergePricingConfig, type PricingMergeAudit } from "../shared/pricingMerge.js";
import { scan, scanChanged } from "./discovery.js";
import { hasIngestedChanges, ingestAll } from "./ingest.js";
import { buildDiagnosticsReport } from "./diagnostics.js";
import { dedupMigrationCanRebuild, storedFilesCanRebuild } from "./migration.js";
import * as queries from "./store/queries.js";
import type { WorkerRequest, WorkerEvent, IngestConfig } from "../shared/workerProtocol.js";
import type { PricingTable } from "../shared/types.js";

type ScanRequest = Extract<WorkerRequest, { type: "scanAndIngest" }>;

let store: UsageStore | undefined;
let pricing: PricingEngine | undefined;
let analytics: AnalyticsService | undefined;
let config: IngestConfig | undefined;
let scanInProgress = false;
let activeScan: ScanRequest | undefined;
let pendingScan: ScanRequest | undefined;
const pendingPricing: Array<Extract<WorkerRequest, { type: "updatePricing" }>> = [];
let pendingReset = false;
let needsDedupKeyMigration = false;
let needsCodexAccountingMigration = false;
let activePricingFingerprint = "";
let pendingFlush = false;
const pendingAnalyticsQueries: Array<Extract<WorkerRequest, { type: "query" }>> = [];
let pricingAudit: PricingMergeAudit = {
  overriddenBundledModels: [],
  ignoredFallbackOverride: false,
  customModelOverrides: [],
};

const FULL_DISCOVERY_MIN_INTERVAL_MS = 2 * 60 * 1000;
const CODEX_FILE_SCOPE_DEDUP_META_KEY = "codex_file_scoped_dedup_v1";
const CODEX_CUMULATIVE_DELTA_META_KEY = "codex_cumulative_delta_accounting_v1";
const PRICING_FINGERPRINT_META_KEY = "pricing_fingerprint_v2";
const AGGREGATE_ALGORITHM_META_KEY = "aggregate_algorithm_version";
const AGGREGATE_FALLBACK_COUNT_META_KEY = "aggregate_fallback_count";
const AGGREGATE_ALGORITHM_VERSION = "2";

function post(event: WorkerEvent): void {
  parentPort!.postMessage(event);
}

/**
 * Sanitize error messages to never include raw log content.
 * Returns only the error message string, truncated if excessively long.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 200 ? err.message.slice(0, 200) : err.message;
  }
  return "Unknown error";
}

/**
 * Classify an error into a structured scope for the host.
 */
function classifyErrorScope(err: unknown, fallbackScope: string): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "ENOENT" || code === "EPERM") {
      return "permission";
    }
    // sql.js failures during open/query
    if (
      err.message.includes("not a database") ||
      err.message.includes("database disk image is malformed") ||
      err.message.includes("SQL") ||
      err.message.includes("sqlite")
    ) {
      return "store";
    }
  }
  return fallbackScope;
}

function mergeScanRequests(existing: ScanRequest | undefined, incoming: ScanRequest): ScanRequest {
  if (!existing) {
    return incoming;
  }

  if (existing.forceFull || incoming.forceFull) {
    return { type: "scanAndIngest", reason: "manual", forceFull: true };
  }

  if (existing.reason !== "watch" || incoming.reason !== "watch") {
    return { type: "scanAndIngest", reason: existing.reason === "activation" || incoming.reason === "activation" ? "activation" : "manual" };
  }

  if (!existing.changedPaths?.length || !incoming.changedPaths?.length) {
    return { type: "scanAndIngest", reason: "watch" };
  }

  return {
    type: "scanAndIngest",
    reason: "watch",
    changedPaths: [...new Set([...existing.changedPaths, ...incoming.changedPaths])],
  };
}

function enqueueScan(req: ScanRequest): void {
  if (isRedundantFullWatchScan(req, activeScan) || isRedundantFullWatchScan(req, pendingScan)) {
    return;
  }

  if (scanInProgress) {
    pendingScan = mergeScanRequests(pendingScan, req);
    return;
  }

  void runScanQueue(req);
}

function enqueueResetDatabase(): void {
  pendingReset = true;
  pendingScan = undefined;

  if (!scanInProgress) {
    void runScanQueue();
  }
}

async function runScanQueue(first?: ScanRequest): Promise<void> {
  scanInProgress = true;
  let current: ScanRequest | undefined = first;

  try {
    while (current || pendingReset || pendingPricing.length > 0) {
      if (current) {
        pendingScan = undefined;
        activeScan = current;
        try {
          await handleScanAndIngest(current);
        } catch (err: unknown) {
          if (store && pricing && current.forceFull) {
            try {
              store.reload();
              analytics = new AnalyticsService(store.database, pricing);
            } catch {
              // Preserve the original scan error; reload is best-effort.
            }
          } else if (store && pricing) {
            try {
              queries.rebuildAggregates(store.database, pricing);
              store.flush();
            } catch {
              // Preserve the original scan error; recovery is best-effort.
            }
          }
          const scope = classifyErrorScope(err, current.type);
          const message = sanitizeErrorMessage(err);
          post({ type: "error", scope, message });
        } finally {
          activeScan = undefined;
        }
        if (pendingReset) {
          pendingScan = undefined;
          current = undefined;
        } else {
          current = pendingScan;
        }
      } else if (pendingReset) {
        pendingReset = false;
        pendingScan = undefined;
        try {
          await handleResetDatabase();
        } catch (err: unknown) {
          if (store && pricing) {
            try {
              store.reload();
              analytics = new AnalyticsService(store.database, pricing);
            } catch {
              // Preserve the reset error; reload is best-effort.
            }
          }
          const scope = classifyErrorScope(err, "resetDatabase");
          const message = sanitizeErrorMessage(err);
          post({ type: "error", scope, message });
        }
        current = pendingScan;
      } else if (pendingPricing.length > 0) {
        const request = pendingPricing.shift()!;
        try {
          handleUpdatePricing(request);
        } catch (err: unknown) {
          const message = sanitizeErrorMessage(err);
          post({ type: "pricingUpdateError", id: request.id, message });
        }
        current = pendingScan;
      }
    }
  } finally {
    scanInProgress = false;
    if (pendingFlush && store) {
      pendingFlush = false;
      store.flush();
    }
    drainPendingAnalyticsQueries();
    if (pendingScan) {
      const queued = pendingScan;
      pendingScan = undefined;
      enqueueScan(queued);
    }
  }
}

function isRedundantFullWatchScan(incoming: ScanRequest, existing: ScanRequest | undefined): boolean {
  return isFullWatchScan(incoming) && existing !== undefined && scanCoversAllSources(existing);
}

function isFullWatchScan(req: ScanRequest): boolean {
  return req.reason === "watch" && !req.forceFull && !req.changedPaths?.length;
}

function scanCoversAllSources(req: ScanRequest): boolean {
  return req.forceFull === true || req.reason !== "watch" || !req.changedPaths?.length;
}

async function handleScanAndIngest(req: ScanRequest): Promise<void> {
  if (!store || !pricing || !analytics || !config) {
    post({ type: "error", scope: "scanAndIngest", message: "Worker not initialized" });
    return;
  }

  // Discover candidate files from configured source roots
  const sourceRoots = {
    codex: config.sources.codex.enabled
      ? { enabled: true, path: config.sources.codex.path ?? "" }
      : undefined,
    claude: config.sources.claude.enabled
      ? { enabled: true, path: config.sources.claude.path ?? "" }
      : undefined,
  };
  if (needsDedupKeyMigration || needsCodexAccountingMigration) {
    const migrationCandidates = fullDiscovery(sourceRoots);
    if (
      !dedupMigrationCanRebuild(store.usageRecordSources(), migrationCandidates) ||
      !storedFilesCanRebuild(store.storedFileIdentities(), migrationCandidates)
    ) {
      post({
        type: "ingestComplete",
        freshness: analytics.freshness(),
        warnings: analytics.warnings(),
        dataChanged: false,
      });
      return;
    }
    const migrationReq: ScanRequest = { type: "scanAndIngest", reason: "manual", forceFull: true };
    await ingestCandidates(migrationReq, migrationCandidates);
    if (needsDedupKeyMigration) {
      store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
    }
    if (needsCodexAccountingMigration) {
      store.setMeta(CODEX_CUMULATIVE_DELTA_META_KEY, "1");
    }
    store.flush();
    needsDedupKeyMigration = false;
    needsCodexAccountingMigration = false;
    return;
  }

  if (req.reason === "watch" && req.changedPaths && req.changedPaths.length > 0) {
    const changedCandidates = scanChanged(req.changedPaths, sourceRoots);
    if (changedCandidates.length > 0) {
      await ingestCandidates(req, changedCandidates);
      return;
    }
    const now = Date.now();
    if (!store.shouldRunFullDiscovery(now, FULL_DISCOVERY_MIN_INTERVAL_MS)) {
      return;
    }
    await ingestCandidates(req, fullDiscovery(sourceRoots, now));
    return;
  }

  const now = Date.now();
  const isEmptyWatchScan = req.reason === "watch" && !req.changedPaths?.length && !req.forceFull;
  const canUseHotCatalog = !req.forceFull && (req.reason === "activation" || isEmptyWatchScan);

  if (canUseHotCatalog) {
    const hotCandidates = scanChanged(store.hotCatalogFilePaths(now), sourceRoots);
    if (hotCandidates.length > 0) {
      await ingestCandidates(req, hotCandidates);
    }

    if (isEmptyWatchScan && !store.shouldRunFullDiscovery(now, FULL_DISCOVERY_MIN_INTERVAL_MS)) {
      return;
    }
  }

  await ingestCandidates(req, fullDiscovery(sourceRoots, now));
}

async function ingestCandidates(req: ScanRequest, candidates: ReturnType<typeof scan>): Promise<void> {
  if (!store || !pricing || !analytics || !config) {
    post({ type: "error", scope: "scanAndIngest", message: "Worker not initialized" });
    return;
  }

  // forceFull (manual rescan): wipe existing data, parse from offset 0
  if (req.forceFull) {
    store.clearIngestedData();
    // Reset quality counters — forceFull re-parses everything from scratch
    store.resetQualityCounters();
  }

  store.recordDiscoveredFiles(candidates);

  const options = {
    maxLineBytes: config.ingestion.maxLineBytes,
    backfillMonths: req.forceFull ? 0 : config.ingestion.backfillMonths,
  };

  const result = await ingestAll(candidates, store, pricing, options, (processed, total) => {
    post({ type: "progress", processed, total, partial: true });
  });

  const dataChanged = hasIngestedChanges(result);
  if (dataChanged) {
    const integrity = queries.aggregateIntegrity(store.database);
    if (!integrity.valid) {
      queries.rebuildAggregates(store.database, pricing);
      const fallbackCount = Number(store.getMeta(AGGREGATE_FALLBACK_COUNT_META_KEY) ?? 0);
      store.setMeta(AGGREGATE_FALLBACK_COUNT_META_KEY, String(fallbackCount + 1));
    }
  }
  store.flush();
  post({ type: "progress", processed: candidates.length, total: candidates.length, partial: false });
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged,
  });
}

function fullDiscovery(sourceRoots: Parameters<typeof scan>[0], now = Date.now()): ReturnType<typeof scan> {
  const candidates = scan(sourceRoots);
  store?.markFullDiscoveryRun(now);
  return candidates;
}

function handleUpdatePricing(request: Extract<WorkerRequest, { type: "updatePricing" }>): void {
  if (!store || !pricing || !analytics) {
    throw new Error("Worker not initialized");
  }
  const merged = mergePricingConfig(request.table);
  pricingAudit = merged.audit;
  pricing = new PricingEngine(merged.table, merged.fallbackRate);
  analytics = new AnalyticsService(store.database, pricing);
  queries.rebuildAggregates(store.database, pricing);
  store.setMeta(PRICING_FINGERPRINT_META_KEY, pricingFingerprint(merged.table, merged.fallbackRate));
  activePricingFingerprint = pricingFingerprint(merged.table, merged.fallbackRate);
  store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
  // Recompute unmapped models with new pricing table
  store.recordUnmappedModels(pricing.unmappedModels(store.distinctModels()), pricing.fallbackModelRate());
  store.flush();
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged: true,
  });
  post({ type: "pricingUpdated", id: request.id });
}

async function handleResetDatabase(): Promise<void> {
  if (!store || !pricing || !analytics || !config) {
    post({ type: "error", scope: "resetDatabase", message: "Worker not initialized" });
    return;
  }

  store.resetDatabase();
  store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
  store.setMeta(CODEX_CUMULATIVE_DELTA_META_KEY, "1");
  store.setMeta(PRICING_FINGERPRINT_META_KEY, activePricingFingerprint);
  store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
  needsDedupKeyMigration = false;
  needsCodexAccountingMigration = false;
  analytics = new AnalyticsService(store.database, pricing);

  const sourceRoots = {
    codex: config.sources.codex.enabled
      ? { enabled: true, path: config.sources.codex.path ?? "" }
      : undefined,
    claude: config.sources.claude.enabled
      ? { enabled: true, path: config.sources.claude.path ?? "" }
      : undefined,
  };
  const req: ScanRequest = { type: "scanAndIngest", reason: "manual", forceFull: true };
  await ingestCandidates(req, fullDiscovery(sourceRoots));
}

async function handleInit(req: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(__dirname, file),
  });

  if (!existsSync(req.dbPath)) {
    if (req.previousDbPath && !existsSync(req.previousDbPath) && req.legacyDbPath && existsSync(req.legacyDbPath)) {
      copyFileSync(req.legacyDbPath, req.previousDbPath);
      const previousStore = new UsageStore();
      await previousStore.open(req.previousDbPath, SQL);
      try {
        await previousStore.migrateOrRebuild(7);
        previousStore.flush();
      } finally {
        previousStore.close();
      }
    }
    const sourcePath = req.previousDbPath && existsSync(req.previousDbPath)
      ? req.previousDbPath
      : req.legacyDbPath && existsSync(req.legacyDbPath)
        ? req.legacyDbPath
        : undefined;
    if (sourcePath) {
      copyFileSync(sourcePath, req.dbPath);
    }
  }
  store = new UsageStore();
  await store.open(req.dbPath, SQL);
  config = req.config;

  const merged = mergePricingConfig(req.config.pricingOverrides);
  pricingAudit = merged.audit;
  pricing = new PricingEngine(merged.table, merged.fallbackRate);
  const schema = await store.migrateOrRebuild();

  analytics = new AnalyticsService(store.database, pricing);
  const usageRecordCount = store.usageRecordCount();
  const codexUsageRecordCount = store.usageRecordCountForSource("codex");
  needsDedupKeyMigration =
    usageRecordCount > 0 && store.getMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY) !== "1";
  needsCodexAccountingMigration =
    codexUsageRecordCount > 0 && store.getMeta(CODEX_CUMULATIVE_DELTA_META_KEY) !== "1";
  if (usageRecordCount === 0 && store.getMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY) !== "1") {
    store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
  }
  if (codexUsageRecordCount === 0 && store.getMeta(CODEX_CUMULATIVE_DELTA_META_KEY) !== "1") {
    store.setMeta(CODEX_CUMULATIVE_DELTA_META_KEY, "1");
  }
  const expectedPricingFingerprint = pricingFingerprint(merged.table, merged.fallbackRate);
  activePricingFingerprint = expectedPricingFingerprint;
  const requiresAggregateRepair =
    schema !== "ok" ||
    store.getMeta(PRICING_FINGERPRINT_META_KEY) !== expectedPricingFingerprint ||
    store.getMeta(AGGREGATE_ALGORITHM_META_KEY) !== AGGREGATE_ALGORITHM_VERSION ||
    !queries.aggregateIntegrity(store.database).valid;
  if (requiresAggregateRepair) {
    queries.rebuildAggregates(store.database, pricing);
  }
  store.setMeta(PRICING_FINGERPRINT_META_KEY, expectedPricingFingerprint);
  store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
  store.recordUnmappedModels(pricing.unmappedModels(store.distinctModels()), pricing.fallbackModelRate());
  store.flush();

  post({ type: "ready", schema });
}

// Flush-on-terminate: persist the db before the worker exits.
process.on("beforeExit", () => {
  if (store) {
    try {
      store.flush();
    } catch {
      // Best-effort; worker is exiting.
    }
  }
});

parentPort!.on("message", (req: WorkerRequest) => {
  (async () => {
    switch (req.type) {
      case "init":
        await handleInit(req);
        break;

      case "query": {
        if (scanInProgress) {
          pendingAnalyticsQueries.push(req);
          return;
        }
        handleAnalyticsQuery(req);
        break;
      }

      case "diagnostics": {
        if (!store || !pricing) {
          post({ type: "error", scope: "diagnostics", message: "Worker not initialized" });
          return;
        }
        post({
          type: "diagnosticsResult",
          id: req.id,
          result: buildDiagnosticsReport(store.database, pricing, pricingAudit),
        });
        break;
      }

      case "scanAndIngest": {
        enqueueScan(req);
        break;
      }

      case "resetDatabase": {
        enqueueResetDatabase();
        break;
      }

      case "updatePricing": {
        if (scanInProgress) {
          pendingPricing.push(req);
        } else {
          try {
            handleUpdatePricing(req);
          } catch (err: unknown) {
            post({ type: "pricingUpdateError", id: req.id, message: sanitizeErrorMessage(err) });
          }
        }
        break;
      }

      case "flush":
        if (scanInProgress) {
          pendingFlush = true;
        } else if (store) {
          store.flush();
        }
        break;
    }
  })().catch((err: unknown) => {
    const scope = classifyErrorScope(err, req.type);
    const message = sanitizeErrorMessage(err);
    post({ type: "error", scope, message });
  });
});

function handleAnalyticsQuery(req: Extract<WorkerRequest, { type: "query" }>): void {
        if (!analytics) {
          post({ type: "queryError", id: req.id, message: "Worker not initialized" });
          return;
        }
        try {
          const result = analytics.query(req.query);
          post({ type: "queryResult", id: req.id, result });
        } catch (err: unknown) {
          post({ type: "queryError", id: req.id, message: sanitizeErrorMessage(err) });
        }
}

function drainPendingAnalyticsQueries(): void {
  const pending = pendingAnalyticsQueries.splice(0);
  for (const query of pending) {
    handleAnalyticsQuery(query);
  }
}

function pricingFingerprint(table: PricingTable, fallbackRate: unknown): string {
  const sortedTable = Object.fromEntries(
    Object.entries(table).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256")
    .update(JSON.stringify({ table: sortedTable, fallbackRate, algorithm: AGGREGATE_ALGORITHM_VERSION }))
    .digest("hex");
}
