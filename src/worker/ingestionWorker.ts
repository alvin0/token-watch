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
import initSqlJs from "sql.js";
import { UsageStore } from "./store/UsageStore.js";
import { PricingEngine } from "./pricing.js";
import { AnalyticsService } from "./analytics.js";
import { DEFAULT_PRICING, FALLBACK_RATE } from "../shared/defaultPricing.js";
import { scan, scanChanged } from "./discovery.js";
import { ingestAll } from "./ingest.js";
import { dedupMigrationCanRebuild } from "./migration.js";
import * as queries from "./store/queries.js";
import type { WorkerRequest, WorkerEvent, IngestConfig } from "../shared/workerProtocol.js";
import type { PricingTable, ModelRate } from "../shared/types.js";

type ScanRequest = Extract<WorkerRequest, { type: "scanAndIngest" }>;

let store: UsageStore | undefined;
let pricing: PricingEngine | undefined;
let analytics: AnalyticsService | undefined;
let config: IngestConfig | undefined;
let scanInProgress = false;
let activeScan: ScanRequest | undefined;
let pendingScan: ScanRequest | undefined;
let pendingPricing: PricingTable | undefined;
let needsDedupKeyMigration = false;

const FULL_DISCOVERY_MIN_INTERVAL_MS = 2 * 60 * 1000;
const CODEX_FILE_SCOPE_DEDUP_META_KEY = "codex_file_scoped_dedup_v1";

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

/**
 * Extract a fallback rate from the merged pricing table's "$fallback" key,
 * falling back to the bundled FALLBACK_RATE constant.
 */
function buildFallbackRate(table: PricingTable): ModelRate {
  const fb = table["$fallback"];
  return fb ?? FALLBACK_RATE;
}

/** Remove meta keys (like $fallback) from a pricing table before passing to PricingEngine. */
function stripMetaKeys(table: PricingTable): PricingTable {
  const result: PricingTable = {};
  for (const [key, value] of Object.entries(table)) {
    if (!key.startsWith("$")) {
      result[key] = value;
    }
  }
  return result;
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

async function runScanQueue(first: ScanRequest): Promise<void> {
  scanInProgress = true;
  let current: ScanRequest | undefined = first;

  try {
    while (current || pendingPricing) {
      if (current) {
        pendingScan = undefined;
        activeScan = current;
        try {
          await handleScanAndIngest(current);
        } catch (err: unknown) {
          const scope = classifyErrorScope(err, current.type);
          const message = sanitizeErrorMessage(err);
          post({ type: "error", scope, message });
        } finally {
          activeScan = undefined;
        }
        current = pendingScan;
      } else if (pendingPricing) {
        const table = pendingPricing;
        pendingPricing = undefined;
        try {
          handleUpdatePricing(table);
        } catch (err: unknown) {
          const scope = classifyErrorScope(err, "updatePricing");
          const message = sanitizeErrorMessage(err);
          post({ type: "error", scope, message });
        }
        current = pendingScan;
      }
    }
  } finally {
    scanInProgress = false;
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
  if (needsDedupKeyMigration) {
    const migrationCandidates = fullDiscovery(sourceRoots);
    if (!dedupMigrationCanRebuild(store.usageRecordSources(), migrationCandidates)) {
      post({
        type: "ingestComplete",
        freshness: analytics.freshness(),
        warnings: analytics.warnings(),
      });
      return;
    }
    const migrationReq: ScanRequest = { type: "scanAndIngest", reason: "manual", forceFull: true };
    await ingestCandidates(migrationReq, migrationCandidates);
    store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
    store.flush();
    needsDedupKeyMigration = false;
    return;
  }

  if (req.reason === "watch" && req.changedPaths && req.changedPaths.length > 0) {
    const changedCandidates = scanChanged(req.changedPaths, sourceRoots);
    const candidates = changedCandidates.length > 0 ? changedCandidates : fullDiscovery(sourceRoots);
    await ingestCandidates(req, candidates);
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

  await ingestAll(candidates, store, pricing, options, (processed, total, fileResult) => {
    post({ type: "progress", processed, total, partial: true });
    const currentAnalytics = analytics;
    if (currentAnalytics && fileResult.decision !== "skip") {
      post({
        type: "ingestComplete",
        freshness: currentAnalytics.freshness(),
        warnings: currentAnalytics.warnings(),
      });
    }
  });

  queries.rebuildAggregates(store.database, pricing);
  store.flush();
  post({ type: "progress", processed: candidates.length, total: candidates.length, partial: false });
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
  });
}

function fullDiscovery(sourceRoots: Parameters<typeof scan>[0], now = Date.now()): ReturnType<typeof scan> {
  const candidates = scan(sourceRoots);
  store?.markFullDiscoveryRun(now);
  return candidates;
}

function handleUpdatePricing(table: PricingTable): void {
  if (!store || !pricing || !analytics) {
    post({ type: "error", scope: "updatePricing", message: "Worker not initialized" });
    return;
  }
  const mergedTable = { ...DEFAULT_PRICING, ...table };
  pricing = new PricingEngine(stripMetaKeys(mergedTable), buildFallbackRate(mergedTable));
  analytics = new AnalyticsService(store.database, pricing);
  queries.rebuildAggregates(store.database, pricing);
  // Recompute unmapped models with new pricing table
  store.recordUnmappedModels(pricing.unmappedModels(store.distinctModels()), pricing.fallbackModelRate());
  store.flush();
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
  });
}

async function handleInit(req: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(__dirname, file),
  });

  store = new UsageStore();
  await store.open(req.dbPath, SQL);
  const schema = await store.migrateOrRebuild();

  config = req.config;

  // Merge default pricing with user overrides
  const mergedTable = { ...DEFAULT_PRICING, ...req.config.pricingOverrides };
  pricing = new PricingEngine(stripMetaKeys(mergedTable), buildFallbackRate(mergedTable));

  analytics = new AnalyticsService(store.database, pricing);
  const usageRecordCount = store.usageRecordCount();
  needsDedupKeyMigration =
    usageRecordCount > 0 && store.getMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY) !== "1";
  if (usageRecordCount === 0 && store.getMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY) !== "1") {
    store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
  } else if (!needsDedupKeyMigration) {
    queries.rebuildAggregates(store.database, pricing);
  }
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
        if (!analytics) {
          post({ type: "error", scope: "query", message: "Worker not initialized" });
          return;
        }
        const result = analytics.query(req.query);
        post({ type: "queryResult", id: req.id, result });
        break;
      }

      case "scanAndIngest": {
        enqueueScan(req);
        break;
      }

      case "updatePricing": {
        if (scanInProgress) {
          pendingPricing = req.table;
        } else {
          handleUpdatePricing(req.table);
        }
        break;
      }

      case "flush":
        if (store) {
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
