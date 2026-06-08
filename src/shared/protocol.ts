/**
 * WebView ↔ host message protocol.
 *
 * `WebviewRequest` flows WebView → host; `HostMessage` flows host → WebView.
 * Results carry only AGGREGATED arrays, never raw logs (Req 8.5). The WebView
 * correlates query responses by the `id` carried on the message envelope.
 *
 * This module MUST NOT import `vscode`.
 */

import { Source, Effort, PricingTable } from "./types";
import {
  DailyAggregate,
  VariantMetrics,
  SessionAggregate,
  ToolUsageRow,
  ToolCallsByDay,
  HourlyAggregate,
  HeatmapCell,
} from "./storeTypes";

/** A single analytics request describing a view + filters + range (Req 5.5, 8.4). */
export interface AnalyticsQuery {
  view: "dashboard" | "series" | "variants" | "sessions" | "tools" | "heatmap" | "comparison";
  granularity: "day" | "week" | "month";
  range: { fromUtc: number; toUtc: number };   // inclusive (Req 5.5)
  sources?: Source[];                           // filters (Req 8.4, 11.18)
  models?: string[];
  efforts?: Effort[];
  workspaces?: string[];
  rollupToBaseModel?: boolean;                  // Req 7.3, 11.9
  breakdownByVariant?: boolean;                 // Req 11.3
}

/** Per-source rollup for the Codex-vs-Claude comparison view (Req 11.12). */
export interface SourceComparison {
  source: Source;
  totalTokens: number;
  costUsd: number;
  costUnknown: boolean;
  turns: number;
  sessions: number;
}

/**
 * Result payload for one `AnalyticsQuery`, discriminated by `view` (matching
 * `AnalyticsQuery["view"]`). The `dashboard` view is a composite carrying the
 * arrays the landing page renders in one round-trip; the others are single-array
 * views. No `id` lives here — it is correlated on the message envelope.
 */
export type AnalyticsResult =
  | { view: "dashboard"; series: DailyAggregate[]; variants: VariantMetrics[]; sessions: SessionAggregate[]; tools: ToolUsageRow[]; toolCallsByDay: ToolCallsByDay[]; hourlySeries: HourlyAggregate[] }
  | { view: "series"; series: DailyAggregate[] }
  | { view: "variants"; variants: VariantMetrics[] }
  | { view: "sessions"; sessions: SessionAggregate[] }
  | { view: "tools"; tools: ToolUsageRow[] }
  | { view: "heatmap"; heatmap: HeatmapCell[] }
  | { view: "comparison"; comparison: SourceComparison[] };

/** Latest known data timestamps for the freshness indicator (Req 15.1). */
export interface FreshnessInfo {
  latestRecordUtc?: number;
  lastIngestRunUtc?: number;
}

/** Non-fatal ingestion warnings surfaced in the UI (Req 15.2, 15.3). */
export interface WarningInfo {
  unmappedModels: string[];     // Req 15.2
  malformedLineCount: number;   // unparseable JSON lines skipped (Req 15.3a)
  oversizedLineCount: number;   // lines skipped over maxLineBytes (Req 15.3b)
}

/** Latest Codex rate-limit percentages seen, informational (Req 14.4). */
export interface RateLimitInfo {
  primaryPct?: number;
  secondaryPct?: number;
  tsUtc?: number;
}

export interface PricingDiagnostics {
  ignoredKnownModelOverrides: string[];
  ignoredFallbackOverride: boolean;
  customModelOverrides: string[];
}

export interface LongContextDiagnosticRow {
  model: string;
  effectiveModel?: string;
  sessions: number;
  turns: number;
  maxContextUsedTokens: number;
}

export interface CrossingMidnightSessionDiagnostic {
  source: Source;
  sessionId: string;
  workspace: string;
  firstDay: string;
  lastDay: string;
  totalTokens: number;
  costUsd: number;
}

export interface FolderDayCostComparison {
  day: string;
  eventCostUsd: number;
  folderCostUsd: number;
  deltaUsd: number;
}

export interface FolderDayMismatchDiagnostic {
  filePath: string;
  folderDay: string;
  eventDays: string[];
  costUsd: number;
}

export interface ReconciliationMismatchDiagnostic {
  filePath: string;
  sessionId: string;
  finalTotalTokens: number;
  ingestedTotalTokens: number;
  deltaTokens: number;
}

export interface DiagnosticsReport {
  generatedAtUtc: number;
  pricing: PricingDiagnostics;
  longContext: {
    thresholdTokens: number;
    applied: LongContextDiagnosticRow[];
    missingRates: LongContextDiagnosticRow[];
  };
  crossingMidnightSessions: CrossingMidnightSessionDiagnostic[];
  folderDayComparison: FolderDayCostComparison[];
  folderDayMismatches: FolderDayMismatchDiagnostic[];
  reconciliation: {
    checkedSessions: number;
    mismatches: ReconciliationMismatchDiagnostic[];
  };
}

/** Secondary display currency, so the WebView formats costs without round-trips (Req 6.5). */
export interface DisplayCurrencyConfig {
  secondary?: string;           // ISO code, e.g. "JPY"; absent → USD only
  secondaryRate?: number;       // USD→secondary multiplier; must be > 0 to display
}

/** WebView → host messages. */
export type WebviewRequest =
  | { type: "ready" }
  | { type: "query"; id: string; query: AnalyticsQuery }
  | { type: "rescan" }
  | { type: "resetDatabase" }
  | { type: "updatePricing"; table: PricingTable }
  | { type: "openSetting"; key: string };

/** Host → WebView messages. */
export type HostMessage =
  | { type: "queryResult"; id: string; result: AnalyticsResult }
  | { type: "queryError"; id: string; message: string }
  | { type: "dataChanged" }                                          // Req 8.7
  | { type: "ingestProgress"; processed: number; total: number; partial: boolean } // Req 4.17
  | {
      type: "status";
      freshness: FreshnessInfo;
      warnings: WarningInfo;
      rateLimit?: RateLimitInfo;          // Req 14.4
      currency?: DisplayCurrencyConfig;   // Req 6.5
    };
