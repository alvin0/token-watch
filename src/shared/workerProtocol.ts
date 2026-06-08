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
  /** User pricing additions; bundled defaults win for known models (Req 6.4, 10.3). */
  pricingOverrides: PricingTable;
  /** Secondary display currency config (Req 6.5). */
  currency: DisplayCurrencyConfig;
  ingestion: {
    maxLineBytes: number;       // lines larger are skipped unbuffered (Req 4.14)
    backfillMonths: number;     // 0 = unlimited; bounds first-time reads (Req 4.24)
    watchDebounceMs: number;    // debounce for watch-driven re-ingest (Req 4.21)
  };
  analytics: {
    anomalyMultiplier: number;  // day cost > k×trailing median flags anomaly (Req 11.15)
    contextFillWarnPct: number; // session peak-fill highlight threshold (Req 14.3)
  };
}

/** Host → worker requests. */
export type WorkerRequest =
  | { type: "init"; dbPath: string; config: IngestConfig }
  | { type: "query"; id: string; query: AnalyticsQuery }
  | { type: "diagnostics"; id: string }
  | { type: "scanAndIngest"; reason: "activation" | "watch" | "manual"; forceFull?: boolean; changedPaths?: string[] }
  | { type: "resetDatabase" }
  | { type: "updatePricing"; table: PricingTable }
  | { type: "flush" };

/** Worker → host events. */
export type WorkerEvent =
  | { type: "ready"; schema: "ok" | "migrated" | "rebuilt" }
  | { type: "queryResult"; id: string; result: AnalyticsResult }
  | { type: "queryError"; id: string; message: string }
  | { type: "diagnosticsResult"; id: string; result: DiagnosticsReport }
  | { type: "progress"; processed: number; total: number; partial: boolean }
  | { type: "ingestComplete"; freshness: FreshnessInfo; warnings: WarningInfo }
  | { type: "error"; scope: string; message: string };
