/**
 * Worker-threads entry point for the ingestion worker.
 *
 * Loads sql.js (wasm), opens/migrates the UsageStore, creates the PricingEngine
 * and AnalyticsService, then dispatches WorkerRequest messages from the host.
 *
 * This module MUST NOT import `vscode`.
 */

import { parentPort } from "worker_threads";
import { note, track, trackAsync, watchForStalls } from "./timeline.js";
import { join } from "node:path";
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import initSqlJs from "sql.js";
import { isConcurrentUsageStoreWriteError, isWriterFenceLostError, UsageStore } from "./store/UsageStore.js";
import { PricingEngine } from "./pricing.js";
import { AnalyticsService } from "./analytics.js";
import { mergePricingConfig, type PricingMergeAudit } from "../shared/pricingMerge.js";
import { scan, scanChanged } from "./discovery.js";
import { hasIngestedChanges, ingestAll } from "./ingest.js";
import { FileQuarantine } from "./quarantine.js";
import { WriterLease } from "./writerLease.js";
import { buildDiagnosticsReport } from "./diagnostics.js";
import { dedupMigrationCanRebuild, storedFilesCanRebuild } from "./migration.js";
import { localTimezoneIdentity, timezoneIdentityChanged } from "../shared/time.js";
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
/** Request ids waiting for the queued reset to finish. */
const pendingResetAcks: string[] = [];
let needsDedupKeyMigration = false;
let needsCodexAccountingMigration = false;
let activePricingFingerprint = "";
let pendingFlush = false;
/** Ids of `flush` requests waiting for the queued flush to actually run. */
const pendingFlushAcks: string[] = [];
/**
 * Set when the host is shutting down. A running scan checks it between files
 * and stops, so the final flush waits for one file rather than a full backfill.
 */
let stopScanRequested = false;
/**
 * Set when a write was refused because the lease moved to another window.
 *
 * The reload that resyncs with the new owner is deferred to the end of the
 * scan: replacing the database object while `ingestAll` is mid-file would
 * discard batches it has already committed and continue against a different
 * snapshot.
 */
let writerFenceLost = false;
const quarantine = new FileQuarantine();
/**
 * Only the lease holder ingests. Other windows keep serving queries and reload
 * the owner's snapshot, instead of racing it and discarding their own work.
 */
let writerLease: WriterLease | undefined;
let pricingAudit: PricingMergeAudit = {
  overriddenBundledModels: [],
  ignoredFallbackOverride: false,
  customModelOverrides: [],
};

const FULL_DISCOVERY_MIN_INTERVAL_MS = 2 * 60 * 1000;
/**
 * How rarely a scan that changed nothing but bookkeeping may rewrite the
 * database. Watch ticks arrive every few seconds; exporting and rewriting the
 * whole file each time is the write amplification this bounds.
 */
const BOOKKEEPING_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How often retention is applied.
 *
 * Pruning ends in a VACUUM — about a second on a large database — so it runs
 * at most daily rather than after every scan. Retention is measured in whole
 * days, so nothing is gained by checking more often.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_PRUNE_META_KEY = "last_prune_utc";
/**
 * How often a long scan persists what it has committed so far.
 *
 * Parser checkpoints only reach sql.js's in-memory database; without this the
 * snapshot is written once at the end of the scan, so a shutdown mid-scan lost
 * every batch since the previous snapshot, not just the last one.
 */
const CHECKPOINT_FLUSH_INTERVAL_MS = 20 * 1000;
const CODEX_FILE_SCOPE_DEDUP_META_KEY = "codex_file_scoped_dedup_v1";
const CODEX_CUMULATIVE_DELTA_META_KEY = "codex_cumulative_delta_accounting_v1";
const PRICING_FINGERPRINT_META_KEY = "pricing_fingerprint_v2";
const AGGREGATE_ALGORITHM_META_KEY = "aggregate_algorithm_version";
const AGGREGATE_FALLBACK_COUNT_META_KEY = "aggregate_fallback_count";
const AGGREGATE_ALGORITHM_VERSION = "2";
const TIMEZONE_IDENTITY_META_KEY = "local_timezone_identity_v1";

function post(event: WorkerEvent): void {
  parentPort!.postMessage(event);
}

/**
 * Pick up the new owner's snapshot after this worker stopped being the writer.
 *
 * Runs only between scans, never inside one, so the database object is never
 * replaced while a file is being committed against it.
 */
function resyncAfterLosingFence(): void {
  if (!writerFenceLost) { return; }
  writerFenceLost = false;
  if (!store || !pricing) { return; }
  try {
    if (!store.reloadIfChangedOnDisk()) { return; }
  } catch (error) {
    post({ type: "error", scope: "follow", message: sanitizeErrorMessage(error) });
    return;
  }
  analytics = new AnalyticsService(store.database, pricing);
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged: true,
  });
}

function reloadAfterConcurrentWrite(): void {
  if (!store || !pricing) {
    return;
  }
  store.reload();
  analytics = new AnalyticsService(store.database, pricing);
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged: true,
  });
  // The reload discarded whatever this worker had ingested in memory. Queue a
  // scan so it is re-derived: files the winning window already ingested come
  // back as cursor "skip", the rest are picked up again.
  enqueueScan({ type: "scanAndIngest", reason: "watch" });
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

function enqueueResetDatabase(id?: string): void {
  pendingReset = true;
  if (id) { pendingResetAcks.push(id); }
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
          if (store && pricing && isConcurrentUsageStoreWriteError(err)) {
            try {
              reloadAfterConcurrentWrite();
            } catch {
              // Preserve the concurrent-write error; reload is best-effort.
            }
          } else if (store && pricing && current.forceFull) {
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
          answerResetAcks();
        } catch (err: unknown) {
          if (store && pricing) {
            try {
              if (isConcurrentUsageStoreWriteError(err)) {
                reloadAfterConcurrentWrite();
              } else {
                store.reload();
                analytics = new AnalyticsService(store.database, pricing);
              }
            } catch {
              // Preserve the reset error; reload is best-effort.
            }
          }
          const scope = classifyErrorScope(err, "resetDatabase");
          const message = sanitizeErrorMessage(err);
          post({ type: "error", scope, message });
          failResetAcks(message);
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
    let queuedFlush: FlushOutcome = { persisted: false, message: "No flush was requested" };
    if (pendingFlush && store) {
      pendingFlush = false;
      queuedFlush = flushOwnedStore();
      if (!queuedFlush.persisted && queuedFlush.concurrent) {
        reloadAfterConcurrentWrite();
      }
    }
    drainPendingFlushAcks(queuedFlush);
    resyncAfterLosingFence();
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

  // A manual rescan is this window explicitly asking to be the writer.
  if (!acquireWriterLease({ steal: req.forceFull === true })) {
    followOwnerSnapshot();
    return;
  }

  // Discover candidate files from configured source roots
  const sourceRoots = activeSourceRoots();
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
    // A manual rescan is the user's "try everything again"; drop the backoffs.
    quarantine.clear();
  }

  store.recordDiscoveredFiles(candidates);

  // A first load/force-rescan has no existing dashboard rows to preserve.
  // Rebuilding derived tables once is substantially cheaper than doing it for
  // every file while still leaving incremental watch scans targeted.
  const deferDerivedUntilEnd = store.usageRecordCount() === 0;

  const options = {
    maxLineBytes: config.ingestion.maxLineBytes,
    backfillMonths: req.forceFull ? 0 : config.ingestion.backfillMonths,
    deferDerivedUntilEnd,
    shouldStop: () => stopScanRequested,
    onCheckpoint: () => {
      // Renew the lease first: a long backfill can outlive the TTL, and an
      // expired lease would let another window start writing underneath us.
      heartbeatWriterLease();
      if (writerFenceLost || !ownsDatabase() || !store) { return; }
      try {
        store.flushIfDue(CHECKPOINT_FLUSH_INTERVAL_MS);
      } catch (error) {
        if (isWriterFenceLostError(error)) {
          // Deferred to the end of the scan; reloading here would swap the
          // database out from under the file being ingested.
          writerFenceLost = true;
        } else if (isConcurrentUsageStoreWriteError(error)) {
          writerFenceLost = true;
        } else {
          post({ type: "error", scope: "flush", message: sanitizeErrorMessage(error) });
        }
      }
    },
  };

  const scanStartedAt = Date.now();
  const result = await ingestAll(
    candidates,
    store,
    pricing,
    options,
    (processed, total) => {
      post({ type: "progress", processed, total, partial: true });
    },
    quarantine,
    (candidate, error) => {
      // Surfaced, not fatal: the scan continues with the next candidate.
      post({
        type: "error",
        scope: classifyErrorScope(error, "ingestFile"),
        message: `${candidate.source} log skipped after a read failure: ${sanitizeErrorMessage(error)}`,
      });
    },
  );

  applyRetentionIfDue();

  note(
    `scan: ${req.reason}${req.forceFull ? " (full)" : ""}`,
    Date.now() - scanStartedAt,
    `${result.processed} of ${candidates.length} files, ${result.skipped} unchanged`
      + `${result.failed > 0 ? `, ${result.failed} failed` : ""}`
      + `${result.stoppedEarly ? ", stopped early" : ""}`,
  );

  const dataChanged = hasIngestedChanges(result);
  if (dataChanged) {
    const integrity = queries.aggregateIntegrity(store.database);
    if (!integrity.valid) {
      queries.rebuildAggregates(store.database, pricing);
      const fallbackCount = Number(store.getMeta(AGGREGATE_FALLBACK_COUNT_META_KEY) ?? 0);
      store.setMeta(AGGREGATE_FALLBACK_COUNT_META_KEY, String(fallbackCount + 1));
    }
  }
  if (writerFenceLost || !ownsDatabase()) {
    // A follower reached here through a scan it started before losing the
    // lease; its rows stay in memory and the owner's snapshot wins.
  } else if (dataChanged) {
    const outcome = flushOwnedStore();
    if (!outcome.persisted && outcome.concurrent) { writerFenceLost = true; }
  } else {
    try {
      store.flushIfDue(BOOKKEEPING_FLUSH_INTERVAL_MS);
    } catch (error) {
      if (isWriterFenceLostError(error) || isConcurrentUsageStoreWriteError(error)) {
        writerFenceLost = true;
      } else {
        post({ type: "error", scope: "flush", message: sanitizeErrorMessage(error) });
      }
    }
  }
  post({ type: "progress", processed: candidates.length, total: candidates.length, partial: false });
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged,
  });
}

/** The discovery roots the current config enables. */
function activeSourceRoots(): Parameters<typeof scan>[0] {
  return {
    codex: config?.sources.codex.enabled
      ? { enabled: true, path: config.sources.codex.path ?? "" }
      : undefined,
    claude: config?.sources.claude.enabled
      ? { enabled: true, path: config.sources.claude.path ?? "" }
      : undefined,
  };
}

/**
 * Apply changed settings in place. Source toggles/paths change what the next
 * scan discovers; ingestion limits change how the next file is read. Neither
 * needs a worker restart, so a settings change no longer requires a reload.
 */
function applyConfig(next: IngestConfig): void {
  const previous = config;
  config = next;
  const sourcesChanged =
    previous?.sources.codex.enabled !== next.sources.codex.enabled ||
    previous?.sources.claude.enabled !== next.sources.claude.enabled ||
    (previous?.sources.codex.path ?? "") !== (next.sources.codex.path ?? "") ||
    (previous?.sources.claude.path ?? "") !== (next.sources.claude.path ?? "");
  if (sourcesChanged) {
    // A new root has never been discovered; force a full pass rather than
    // waiting for the throttled discovery interval to come round.
    enqueueScan({ type: "scanAndIngest", reason: "manual" });
  }

  const retentionChanged =
    (previous?.retention?.rawRecordDays ?? 0) !== (next.retention?.rawRecordDays ?? 0);
  if (retentionChanged && store && !writerFenceLost && ownsDatabase()) {
    // Retention is throttled to once a day so its VACUUM is not paid for on
    // every scan. Someone who has just changed the setting should not have to
    // wait out that window to see it take effect.
    store.setMeta(LAST_PRUNE_META_KEY, "0");
    enqueueScan({ type: "scanAndIngest", reason: "manual" });
  }
}

/** Take or renew the writer lease. Without one, this worker is a follower. */
function acquireWriterLease(options: { steal?: boolean } = {}): boolean {
  return writerLease ? writerLease.tryAcquire(options) : true;
}

/**
 * Whether this worker currently owns the right to mutate the shared database.
 *
 * Checked before every mutating path, not just before a scan: init repair,
 * pricing rebuilds and resets all rewrite the same global file.
 */
function ownsDatabase(): boolean {
  return writerLease ? writerLease.isOwner() : true;
}

/**
 * Renew the lease mid-scan. A full backfill can run far longer than the lease
 * TTL, and an expired lease would let a second window start writing underneath
 * this one.
 */
function heartbeatWriterLease(): void {
  writerLease?.tryAcquire();
}

/**
 * Follower path: pick up whatever the owning window has written, so the panel
 * in this window still tracks reality without any of them fighting over the
 * file.
 */
function followOwnerSnapshot(): void {
  if (!store || !pricing) { return; }
  let reloaded = false;
  try {
    reloaded = store.reloadIfChangedOnDisk();
  } catch (error) {
    post({ type: "error", scope: "follow", message: sanitizeErrorMessage(error) });
    return;
  }
  if (!reloaded) { return; }
  analytics = new AnalyticsService(store.database, pricing);
  post({
    type: "ingestComplete",
    freshness: analytics.freshness(),
    warnings: analytics.warnings(),
    dataChanged: true,
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
  // Rebuilding aggregates rewrites every cost in the shared database. A
  // follower must not do that behind the owner's back; it applies the table in
  // memory so this window's panel is right, and lets the owner persist it.
  const owner = acquireWriterLease();
  const previousPricing = pricing;
  const previousPricingAudit = pricingAudit;
  const previousPricingFingerprint = activePricingFingerprint;
  try {
    const merged = mergePricingConfig(request.table);
    pricingAudit = merged.audit;
    pricing = new PricingEngine(merged.table, merged.fallbackRate);
    analytics = new AnalyticsService(store.database, pricing);
    activePricingFingerprint = pricingFingerprint(merged.table, merged.fallbackRate);

    // Costs live in `daily_aggregate`, not in the pricing engine, so a new
    // engine alone changes nothing the dashboard reads. Every worker rebuilds
    // in memory — otherwise a follower window kept showing the OLD prices
    // indefinitely — and only the owner writes that rebuild back.
    queries.rebuildAggregates(store.database, pricing);

    if (owner) {
      store.setMeta(PRICING_FINGERPRINT_META_KEY, activePricingFingerprint);
      store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
      // Recompute unmapped models with new pricing table
      store.recordUnmappedModels(pricing.unmappedModels(store.distinctModels()), pricing.fallbackModelRate());
      store.flush();
    }
  } catch (error) {
    pricing = previousPricing;
    pricingAudit = previousPricingAudit;
    activePricingFingerprint = previousPricingFingerprint;
    if (isConcurrentUsageStoreWriteError(error)) {
      reloadAfterConcurrentWrite();
    } else {
      store.reload();
      analytics = new AnalyticsService(store.database, pricing);
    }
    throw error;
  }
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

  // An explicit reset is a user action in this window; take the lease for it.
  if (!acquireWriterLease({ steal: true })) {
    post({
      type: "error",
      scope: "resetDatabase",
      message: "Another VS Code window owns the usage database right now; close it and try again.",
    });
    return;
  }

  store.resetDatabase();
  store.setMeta(TIMEZONE_IDENTITY_META_KEY, localTimezoneIdentity());
  store.setMeta(CODEX_FILE_SCOPE_DEDUP_META_KEY, "1");
  store.setMeta(CODEX_CUMULATIVE_DELTA_META_KEY, "1");
  store.setMeta(PRICING_FINGERPRINT_META_KEY, activePricingFingerprint);
  store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
  needsDedupKeyMigration = false;
  needsCodexAccountingMigration = false;
  analytics = new AnalyticsService(store.database, pricing);

  // Persist the empty database NOW. The re-ingest below reports
  // `dataChanged: false` when there is nothing new to read, which routes its
  // flush through the bookkeeping throttle — so a reset on an idle machine
  // lived only in memory, and a crash brought every deleted row back.
  quarantineResetSnapshot();

  const sourceRoots = activeSourceRoots();
  const req: ScanRequest = { type: "scanAndIngest", reason: "manual", forceFull: true };
  await ingestCandidates(req, fullDiscovery(sourceRoots));
}

/** Write the just-cleared database straight to disk. */
function quarantineResetSnapshot(): void {
  if (!store) { return; }
  try {
    store.flush({ force: true });
  } catch (error) {
    if (isConcurrentUsageStoreWriteError(error)) {
      reloadAfterConcurrentWrite();
    } else {
      post({ type: "error", scope: "resetDatabase", message: sanitizeErrorMessage(error) });
    }
  }
}

async function handleInit(req: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(__dirname, file),
  });

  // The lease is taken BEFORE anything touches the files. Quarantining and the
  // v7/legacy migration copy both rewrite the shared database, so doing them
  // first meant a follower could clobber the owner's file during startup.
  writerLease = new WriterLease({ leasePath: `${req.dbPath}.owner` });
  const owner = writerLease.tryAcquire({ steal: req.resetDatabase === true });

  if (req.resetDatabase) {
    if (!owner) {
      throw new Error("Another VS Code window owns the usage database; close it and reset again.");
    }
    // The host asks for this when a previous worker could not even open the
    // file. Move each generation aside rather than deleting it, so a damaged
    // database is still available for diagnosis.
    //
    // Every generation, not just v8: leaving v7 or the legacy file in place
    // meant the migration copy below immediately restored the data the reset
    // was supposed to clear.
    for (const path of [req.dbPath, req.previousDbPath, req.legacyDbPath]) {
      if (path) { quarantineDatabaseFile(path); }
    }
  }

  // Upgrading a previous generation into place writes the shared database, so
  // only the lease holder may do it. Two windows starting together would
  // otherwise both copy and migrate the same files.
  if (owner && !existsSync(req.dbPath)) {
    if (req.previousDbPath && !existsSync(req.previousDbPath) && req.legacyDbPath && existsSync(req.legacyDbPath)) {
      copyFileSync(req.legacyDbPath, req.previousDbPath);
      const previousStore = new UsageStore();
      await previousStore.open(req.previousDbPath, SQL);
      try {
        await previousStore.migrateOrRebuild(7);
        previousStore.flush({ force: true });
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
  watchForStalls();
  store = new UsageStore();
  const openedStore = store;
  await trackAsync("init: open database", () => openedStore.open(req.dbPath, SQL));
  // Every write from here on is gated on still holding the lease, checked
  // inside the store's write lock rather than trusted from before the scan.
  store.setWriteFence(() => writerLease?.isOwner() ?? true);
  config = req.config;

  const merged = mergePricingConfig(req.config.pricingOverrides);
  pricingAudit = merged.audit;
  pricing = new PricingEngine(merged.table, merged.fallbackRate);
  const storeForMigration = store;
  const schema = await trackAsync("init: migrate schema", () => storeForMigration.migrateOrRebuild(),
    () => `-> ${storeForMigration.schemaVersion()}`);

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

  // `day_local`/`hour_local` were materialized in whatever timezone the machine
  // was in at ingest. If that has changed — a move, or the same global database
  // opened over Remote SSH or WSL — every stored day boundary is now wrong
  // relative to what the panel calls "today", so the affected files are re-read.
  const timezoneIdentity = localTimezoneIdentity();
  const storedTimezone = store.getMeta(TIMEZONE_IDENTITY_META_KEY);
  const timezoneMoved = timezoneIdentityChanged(storedTimezone, timezoneIdentity);
  if (timezoneMoved) {
    post({
      type: "error",
      scope: "timezone",
      message: `Timezone changed from ${storedTimezone} to ${timezoneIdentity}; re-reading logs so daily totals line up.`,
    });
  }
  const requiresAggregateRepair =
    timezoneMoved ||
    schema !== "ok" ||
    store.getMeta(PRICING_FINGERPRINT_META_KEY) !== expectedPricingFingerprint ||
    store.getMeta(AGGREGATE_ALGORITHM_META_KEY) !== AGGREGATE_ALGORITHM_VERSION ||
    !queries.aggregateIntegrity(store.database).valid;
  if (timezoneMoved) {
    // Aggregates rebuild from usage_record, whose day columns are themselves
    // stale, so the rows have to be parsed again in the new timezone.
    enqueueScan({ type: "scanAndIngest", reason: "manual", forceFull: true });
  }

  // Ready as soon as the database can be read, which is what decides how long
  // the panel sits on a spinner. Rebuilding every aggregate takes about a
  // second and a half on a large database, and the numbers already on disk are
  // good enough to draw in the meantime — so it happens after, and the panel is
  // told to refetch when it lands.
  post({ type: "ready", schema });
  void finishInit({
    owner,
    timezoneIdentity,
    expectedPricingFingerprint,
    requiresAggregateRepair,
  });
}

/**
 * The part of startup the reader does not have to wait for.
 *
 * Deferred rather than skipped: an aggregate repair still has to happen, and
 * the owner still has to write it back. Running it here means the first tab
 * draws from what was already stored while this catches up behind it.
 */
async function finishInit(state: {
  owner: boolean;
  timezoneIdentity: string;
  expectedPricingFingerprint: string;
  requiresAggregateRepair: boolean;
}): Promise<void> {
  // Let the ready message and any query already queued behind it go first.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  if (!store || !pricing) { return; }

  try {
    if (state.requiresAggregateRepair) {
      // In memory either way, so this window reads correct numbers; only the
      // owner writes the repair back to the shared file.
      const db = store.database;
      const engine = pricing;
      track("init: rebuild aggregates", () => queries.rebuildAggregates(db, engine));
    }
    if (state.owner) {
      store.setMeta(TIMEZONE_IDENTITY_META_KEY, state.timezoneIdentity);
      store.setMeta(PRICING_FINGERPRINT_META_KEY, state.expectedPricingFingerprint);
      store.setMeta(AGGREGATE_ALGORITHM_META_KEY, AGGREGATE_ALGORITHM_VERSION);
      store.recordUnmappedModels(
        pricing.unmappedModels(store.distinctModels()),
        pricing.fallbackModelRate(),
      );
      try {
        store.flush();
      } catch (error) {
        if (!isConcurrentUsageStoreWriteError(error)) { throw error; }
        store.reload();
        analytics = new AnalyticsService(store.database, pricing);
      }
    }
    if (state.requiresAggregateRepair && analytics) {
      // The panel is already drawing the pre-repair numbers, so tell it to
      // fetch again now that they have been corrected.
      post({
        type: "ingestComplete",
        freshness: analytics.freshness(),
        warnings: analytics.warnings(),
        dataChanged: true,
      });
    }
  } catch (error) {
    post({ type: "error", scope: "init", message: sanitizeErrorMessage(error) });
  }
}

/**
 * Move a database aside so the next open starts from a clean file.
 *
 * Renamed rather than deleted: if the reset was a mistake, or the corruption is
 * worth reporting, the bytes are still there.
 */
function quarantineDatabaseFile(dbPath: string): void {
  if (!existsSync(dbPath)) { return; }
  const quarantined = `${dbPath}.corrupt-${Date.now()}`;
  try {
    renameSync(dbPath, quarantined);
    post({ type: "error", scope: "resetDatabase", message: `Moved the previous database to ${quarantined}` });
  } catch {
    // A rename can fail if the file is locked; deleting is the only way back.
    try { unlinkSync(dbPath); } catch { /* the open below will report it */ }
  }
  // NOT `.owner`: that is the lease this worker acquired to be allowed to do
  // the reset at all. Deleting it here handed ownership to any other window
  // mid-reset while this one carried on writing.
  try { unlinkSync(`${dbPath}.lock`); } catch { /* absent is fine */ }
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
  // Hand the lease straight over instead of making the next window wait it out.
  writerLease?.release();
});

parentPort!.on("message", (req: WorkerRequest) => {
  (async () => {
    switch (req.type) {
      case "init":
        try {
          await handleInit(req);
        } catch (err: unknown) {
          // The host is blocked on the handshake; a generic "error" event would
          // leave its ready promise pending forever.
          post({ type: "initError", scope: classifyErrorScope(err, "init"), message: sanitizeErrorMessage(err) });
        }
        break;

      case "query": {
        // Answered during a scan, not after it.
        //
        // These used to be held back until the scan finished, on the reasoning
        // that a half-ingested database is not worth reading. On a first pass
        // over a large set of logs that is minutes, and the host gives up on a
        // query after thirty seconds — so the panel showed a progress bar and
        // then an error, having had rows available to it within the first
        // second. sql.js is synchronous and every commit is a transaction, so a
        // query between commits sees a consistent database; it is simply an
        // earlier one than the scan will finish with, which is what a progress
        // bar is for.
        handleAnalyticsQuery(req);
        break;
      }

      case "diagnostics": {
        if (!store || !pricing) {
          post({ type: "diagnosticsError", id: req.id, message: "Worker not initialized" });
          return;
        }
        try {
          post({
            type: "diagnosticsResult",
            id: req.id,
            result: buildDiagnosticsReport(store.database, pricing, pricingAudit),
          });
        } catch (err: unknown) {
          post({ type: "diagnosticsError", id: req.id, message: sanitizeErrorMessage(err) });
        }
        break;
      }

      case "updateConfig": {
        try {
          applyConfig(req.config);
          post({ type: "configUpdated", id: req.id });
        } catch (err: unknown) {
          post({ type: "configUpdateError", id: req.id, message: sanitizeErrorMessage(err) });
        }
        break;
      }

      case "scanAndIngest": {
        enqueueScan(req);
        break;
      }

      case "resetDatabase": {
        enqueueResetDatabase(req.id);
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
        if (req.stopScan) { stopScanRequested = true; }
        if (scanInProgress) {
          pendingFlush = true;
          // Acknowledge only once the queued flush has actually run.
          if (req.id) { pendingFlushAcks.push(req.id); }
        } else {
          const outcome = flushOwnedStore();
          if (req.id) { post({ type: "flushed", id: req.id, ...outcome }); }
        }
        break;
    }
  })().catch((err: unknown) => {
    const scope = classifyErrorScope(err, req.type);
    const message = sanitizeErrorMessage(err);
    if (req.type === "init") {
      post({ type: "initError", scope, message });
      return;
    }
    post({ type: "error", scope, message });
  });
});

/**
 * Drop per-turn rows past the configured retention window.
 *
 * Only the owner prunes: it is a write, and a follower doing it would delete
 * rows from a snapshot it is about to replace anyway. Daily and per-session
 * totals are never touched, so the dashboard history survives; the aggregate
 * rebuild is taught to leave those older rows alone by the watermark the prune
 * records.
 */
function applyRetentionIfDue(now = Date.now()): void {
  const days = config?.retention?.rawRecordDays ?? 0;
  if (!store || days <= 0) { return; }
  if (writerFenceLost || !ownsDatabase()) { return; }
  const last = Number(store.getMeta(LAST_PRUNE_META_KEY) ?? 0);
  if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) { return; }

  try {
    // What it removed is reported by "Token Watch: Show Diagnostics" under
    // Retention, which outlives a log line and answers the question people
    // actually ask: which days still have per-turn detail.
    store.pruneRawRecords(days, now);
    store.setMeta(LAST_PRUNE_META_KEY, String(now));
  } catch (error) {
    if (isWriterFenceLostError(error) || isConcurrentUsageStoreWriteError(error)) {
      writerFenceLost = true;
      return;
    }
    post({ type: "error", scope: "flush", message: sanitizeErrorMessage(error) });
  }
}

function handleAnalyticsQuery(req: Extract<WorkerRequest, { type: "query" }>): void {
        if (!analytics) {
          post({ type: "queryError", id: req.id, message: "Worker not initialized" });
          return;
        }
        const service = analytics;
        try {
          const result = track(
            `query: ${req.query.view}/${req.query.granularity ?? "-"}`,
            () => service.query(req.query),
          );
          post({ type: "queryResult", id: req.id, result });
        } catch (err: unknown) {
          post({ type: "queryError", id: req.id, message: sanitizeErrorMessage(err) });
        }
}

interface FlushOutcome {
  persisted: boolean;
  message?: string;
  concurrent?: boolean;
}

/**
 * Flush, reporting truthfully whether anything reached disk.
 *
 * A failed write used to be logged and then acknowledged as if it had
 * succeeded, so the host terminated the worker believing the data was safe.
 */
function flushOwnedStore(): FlushOutcome {
  if (!store) {
    return { persisted: false, message: "Worker not initialized" };
  }
  if (!ownsDatabase()) {
    return { persisted: false, message: "Another window owns the usage database" };
  }
  try {
    const wrote = store.flush();
    return wrote
      ? { persisted: true }
      : { persisted: true, message: "Nothing to write; the database was unchanged" };
  } catch (error) {
    if (isWriterFenceLostError(error)) {
      // The lease moved between deciding to write and the write itself. Stop
      // writing; resync once the scan is out of the way.
      writerFenceLost = true;
      return { persisted: false, message: sanitizeErrorMessage(error) };
    }
    const message = sanitizeErrorMessage(error);
    post({ type: "error", scope: "flush", message });
    return { persisted: false, message, concurrent: isConcurrentUsageStoreWriteError(error) };
  }
}

/** Tell the host the reset finished, and how much data survived it. */
function answerResetAcks(): void {
  const records = store?.usageRecordCount() ?? 0;
  for (const id of pendingResetAcks.splice(0)) {
    post({ type: "resetComplete", id, records });
  }
}

/** Tell the host the reset failed, rather than leaving the command silent. */
function failResetAcks(message: string): void {
  for (const id of pendingResetAcks.splice(0)) {
    post({ type: "resetError", id, message });
  }
}

/** Answer every `flush` request that was queued behind a running scan. */
function drainPendingFlushAcks(outcome: FlushOutcome): void {
  for (const id of pendingFlushAcks.splice(0)) {
    post({
      type: "flushed",
      id,
      persisted: outcome.persisted,
      ...(outcome.message ? { message: outcome.message } : {}),
    });
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
