/**
 * Host ↔ worker message protocol.
 *
 * `WorkerRequest` flows host → worker; `WorkerEvent` flows worker → host. The
 * worker owns parsing, normalization, pricing, and the persistent store; it never
 * touches `vscode`. `IngestConfig` is the resolved configuration the host passes
 * at `init` (derived from the `tokenWatch.*` settings, Req 10).
 *
 * This module MUST NOT import `vscode`.
 */

import { PricingTable } from "./types";
import {
  AnalyticsQuery,
  AnalyticsResult,
  DiagnosticsReport,
  FreshnessInfo,
  WarningInfo,
  DisplayCurrencyConfig,
} from "./protocol";

/** Per-source ingestion toggle + optional custom log root (Req 10.1, 10.2). */
export interface SourceConfig {
  enabled: boolean;
  /** Custom log root; empty/undefined means the source's default location. */
  path?: string;
}

/**
 * Resolved worker configuration passed at `init`. Mirrors the authoritative
 * `tokenWatch.*` settings (Req 10 Configuration Schema): source toggles/paths,
 * pricing overrides, secondary-currency display, ingestion limits, and analytics
 * thresholds. Kept minimal — only what the worker needs to ingest and aggregate.
 */
export interface IngestConfig {
  sources: {
    codex: SourceConfig;
    claude: SourceConfig;
  };
  /** User pricing additions and overrides; user entries win for matching model ids. */
  pricingOverrides: PricingTable;
  /** Secondary display currency config (Req 6.5). */
  currency: DisplayCurrencyConfig;
  ingestion: {
    maxLineBytes: number;       // lines larger are skipped unbuffered (Req 4.14)
    backfillMonths: number;     // 0 = unlimited; bounds first-time reads (Req 4.24)
    watchDebounceMs: number;    // debounce for watch-driven re-ingest (Req 4.21)
  };
  retention: {
    /**
     * Days of per-turn detail to keep; 0 keeps everything. Daily and session
     * totals are never pruned, so only hourly drill-down, tool detail and
     * retroactive repricing are lost for older days.
     */
    rawRecordDays: number;
  };
  analytics: {
    anomalyMultiplier: number;  // day cost > k×trailing median flags anomaly (Req 11.15)
    contextFillWarnPct: number; // session peak-fill highlight threshold (Req 14.3)
  };
}

/** Host → worker requests. */
export type WorkerRequest =
  | {
      type: "init";
      dbPath: string;
      previousDbPath?: string;
      legacyDbPath?: string;
      config: IngestConfig;
      /**
       * Move any existing database aside before opening. The only recovery
       * path for a file too damaged for `open`/`migrate` to succeed, which is
       * precisely when the user reaches for "Reset Database".
       */
      resetDatabase?: boolean;
    }
  | { type: "query"; id: string; query: AnalyticsQuery }
  | { type: "diagnostics"; id: string }
  | { type: "scanAndIngest"; reason: "activation" | "watch" | "manual"; forceFull?: boolean; changedPaths?: string[] }
  | { type: "resetDatabase"; id?: string }
  | { type: "updatePricing"; id: string; table: PricingTable }
  /** Apply changed `tokenWatch.*` settings without restarting the worker (Req 10.6). */
  | { type: "updateConfig"; id: string; config: IngestConfig }
  /**
   * `id` asks for a `flushed` acknowledgement, so shutdown can wait for it.
   * `stopScan` additionally asks a running scan to stop at the next file
   * boundary, so shutdown waits for one file rather than a whole backfill.
   */
  | { type: "flush"; id?: string; stopScan?: boolean };

/** Worker → host events. */
export type WorkerEvent =
  | { type: "ready"; schema: "ok" | "migrated" | "rebuilt" }
  /**
   * Initialization failed. Without this the host's ready promise could never
   * settle: an `init` throw only surfaced as a generic `error` event, which the
   * host merely logs, so activation waited forever.
   */
  | { type: "initError"; scope: string; message: string }
  | { type: "queryResult"; id: string; result: AnalyticsResult }
  | { type: "queryError"; id: string; message: string }
  | { type: "diagnosticsResult"; id: string; result: DiagnosticsReport }
  | { type: "diagnosticsError"; id: string; message: string }
  | { type: "pricingUpdated"; id: string }
  | { type: "pricingUpdateError"; id: string; message: string }
  | { type: "configUpdated"; id: string }
  /**
   * A `flush` request has been dealt with. `persisted` is false when the write
   * failed or was not this worker's to make — the host must not read the
   * acknowledgement alone as "the data is safe".
   */
  | { type: "flushed"; id: string; persisted: boolean; message?: string }
  | { type: "resetComplete"; id: string; records: number }
  | { type: "resetError"; id: string; message: string }
  | { type: "configUpdateError"; id: string; message: string }
  | { type: "progress"; processed: number; total: number; partial: boolean }
  | { type: "ingestComplete"; freshness: FreshnessInfo; warnings: WarningInfo; dataChanged: boolean }
  | { type: "error"; scope: string; message: string };
