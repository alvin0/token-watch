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
import type { AppLanguage } from "./i18n";

/** A single analytics request describing a view + filters + range (Req 5.5, 8.4). */
export interface AnalyticsQuery {
  view: "dashboard" | "hourly" | "series" | "variants" | "sessions" | "tools" | "heatmap" | "comparison";
  granularity: "day" | "week" | "month";
  range: { fromUtc: number; toUtc: number };   // inclusive (Req 5.5)
  sources?: Source[];                           // filters (Req 8.4, 11.18)
  models?: string[];
  efforts?: Effort[];
  workspaces?: string[];
  rollupToBaseModel?: boolean;                  // Req 7.3, 11.9
  breakdownByVariant?: boolean;                 // Req 11.3
  /**
   * Sub-range for the dashboard's hourly series.
   *
   * The hourly rollup is only ever drawn for a day or two, while `range` also
   * has to cover whatever trailing history the comparisons need. Tying the two
   * together meant widening the window for a baseline silently returned no
   * hourly data at all.
   */
  hourlyRange?: { fromUtc: number; toUtc: number };
  /**
   * The window the UI actually displays.
   *
   * `range` covers everything the worker must READ: the visible period, the
   * period it is compared against, and the trailing history the cost-anomaly
   * baseline needs. Results that the UI renders whole rather than filtering by
   * day — the tool table and the session lists — must be scoped to what the
   * reader is looking at, or the Today tab shows three weeks of tool calls.
   *
   * Defaults to `range` for callers that do not distinguish the two.
   */
  visibleRange?: { fromUtc: number; toUtc: number };
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
  | {
      view: "dashboard";
      series: DailyAggregate[];
      variants: VariantMetrics[];
      /** Top sessions by cost, truncated for display. */
      sessions: SessionAggregate[];
      /** Top sessions by peak context fill — the set the context warning reads. */
      contextSessions: SessionAggregate[];
      tools: ToolUsageRow[];
      toolCallsByDay: ToolCallsByDay[];
      hourlySeries: HourlyAggregate[];
    }
  | { view: "hourly"; hourlySeries: HourlyAggregate[] }
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

/** Ingestion worker health as the host sees it. */
export interface WorkerHealthInfo {
  status: "starting" | "ready" | "restarting" | "failed";
  message?: string;
  restarts: number;
}

/** Non-fatal ingestion warnings surfaced in the UI (Req 15.2, 15.3). */
export interface WarningInfo {
  unmappedModels: string[];     // Req 15.2
  malformedLineCount: number;   // unparseable JSON lines skipped (Req 15.3a)
  /**
   * Lines skipped for exceeding `maxLineBytes` that carried NO token data
   * (Req 15.3b). Informational only — nothing countable was in them.
   */
  oversizedLineCount: number;
  /**
   * Lines whose token data could not be read at all. The only counter that
   * means tokens are missing from the totals.
   */
  lostUsageLineCount: number;
}

/** Latest Codex rate-limit percentages seen, informational (Req 14.4). */
export interface UsageQuotaWindow {
  id: string;
  label: string;
  usedPct?: number;
  resetAtUtc?: number;
  windowSeconds?: number;
  isActive?: boolean;
}

/** One "usage limit reset" granted to the account — restores a 5h/weekly limit, and expires. */
export interface UsageLimitReset {
  id: string;
  title?: string;
  expiresAtUtc?: number;
}

/**
 * Usage limit resets the account can still use. These restore a reached rate
 * limit; they are NOT billing credits. `resets` is absent until the detail
 * request has been made, so the count can stand on its own.
 */
export interface UsageLimitResetsInfo {
  availableCount: number;
  resets?: UsageLimitReset[];
}

export interface RateLimitInfo {
  primaryPct?: number;
  secondaryPct?: number;
  remainingSeconds?: number;
  weeklyResetAtUtc?: number;
  windows: UsageQuotaWindow[];
  limitResets?: UsageLimitResetsInfo;
  tsUtc?: number;
}

/** Latest Claude Code subscription quota percentages. */
export interface ClaudeRateLimitInfo {
  fiveHourPct?: number;
  weeklyPct?: number;
  fiveHourResetAtUtc?: number;
  weeklyResetAtUtc?: number;
  windows: UsageQuotaWindow[];
  tsUtc?: number;
}

export interface PricingDiagnostics {
  /**
   * Models seen in the logs with no rate. Their tokens are counted normally;
   * only their cost reads low, which is why the panel does not raise it.
   */
  unmappedModels?: string[];
  overriddenBundledModels: string[];
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
  aggregate: {
    valid: boolean;
    fallbackCount: number;
    algorithmVersion?: string;
  };
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
  /**
   * What ingestion could and could not read. Only `malformedLineCount` and
   * `lostUsageLineCount` mean tokens are absent from the totals;
   * `oversizedLineCount` is long lines that held no token counts, which is why
   * the panel does not mention it.
   */
  ingestion: {
    malformedLineCount: number;
    oversizedLineCount: number;
    oversizedRecoveredCount: number;
    lostUsageLineCount: number;
  };
  /**
   * What the worker spent its time on, measured on the machine it ran on.
   *
   * `stalls` is the one to read first: it is how long the worker went without
   * being able to answer anything, which is what an unresponsive panel is.
   */
  timing: {
    upMs: number;
    spans: Array<{ name: string; ms: number; atMs: number; detail?: string }>;
    stalls: Array<{ ms: number; atMs: number }>;
  };
  /** What retention has pruned, what that costs, and who can still read it. */
  retention: {
    /**
     * The schema number on the file. Raised only once retention has actually
     * pruned, to keep builds that predate it from rebuilding the kept totals
     * out of the deleted rows. The first thing to check when a window reports
     * that it cannot open the database.
     */
    schemaVersion: number;
    /**
     * First local day that still has per-turn rows, or undefined when nothing
     * has been pruned. Daily and session totals exist for every day either way.
     */
    retainedFromDay?: string;
    rawRecordCount: number;
  };
}

/**
 * Analytics thresholds the WebView applies (Req 11.15, 14.3).
 *
 * These come straight from `tokenWatch.analytics.*`. They live on the status
 * message so a settings change reaches the UI without a reload.
 */
export interface AnalyticsThresholds {
  /** Day cost above k × trailing median is flagged as an anomaly. */
  anomalyMultiplier: number;
  /** Session peak context fill at or above this percent is highlighted. */
  contextFillWarnPct: number;
}

/** Secondary display currency, so the WebView formats costs without round-trips (Req 6.5). */
export interface DisplayCurrencyConfig {
  secondary?: string;           // ISO code, e.g. "JPY"; absent → USD only
  secondaryRate?: number;       // USD→secondary multiplier; must be > 0 to display
}

export type UsageProvider = "codex" | "claude";

/** Subscription plan of the signed-in account for a usage provider, informational. */
export interface UsagePlanInfo {
  id?: string;      // raw provider value, e.g. "prolite", "max_20x"
  label: string;    // display label, e.g. "Pro Lite", "Max 20×"
}

export interface UsageCacheInfo {
  cachedAtUtc?: number;
  retryAtUtc?: number;
  retryPending?: boolean;
  refreshing?: boolean;
  unavailable?: boolean;
}

export type CostAlertPeriod = "day" | "week" | "month";
export type CostAlertSource = "all" | Source;

export interface CostAlertRule {
  id: string;
  period: CostAlertPeriod;
  source: CostAlertSource;
  budgetUsd: number;
}

/** WebView → host messages. */
export type WebviewRequest =
  | { type: "ready" }
  | { type: "query"; id: string; query: AnalyticsQuery }
  | { type: "rescan" }
  | { type: "updatePricing"; table: PricingTable }
  | { type: "refreshUsage"; provider: UsageProvider }
  /**
   * Spend one Codex usage limit reset. Codex-only: no other provider grants
   * them. State-changing, so it carries a request ID and is answered.
   */
  | { type: "consumeLimitReset"; requestId: string; resetId: string }
  | { type: "openSetting"; key: string }
  | { type: "setLanguage"; language: AppLanguage }
  | { type: "savePricingSettings"; requestId: string; table: PricingTable }
  | { type: "saveCostAlertSettings"; requestId: string; rules: CostAlertRule[] };

/** Host → WebView messages. */
export type HostMessage =
  | { type: "queryResult"; id: string; result: AnalyticsResult }
  | { type: "queryError"; id: string; message: string }
  | { type: "dataChanged" }                                          // Req 8.7
  | { type: "ingestProgress"; processed: number; total: number; partial: boolean } // Req 4.17
  | { type: "costAlertSettings"; rules: CostAlertRule[] }
  | { type: "costAlertSettingsSaved"; requestId: string; rules: CostAlertRule[] }
  | { type: "costAlertSettingsError"; requestId: string; message: string }
  | { type: "pricingSettings"; table: PricingTable }
  | { type: "pricingSettingsSaved"; requestId: string; table: PricingTable }
  | { type: "pricingSettingsError"; requestId: string; message: string }
  | { type: "limitResetConsumed"; requestId: string }
  | { type: "limitResetError"; requestId: string; message: string }
  | { type: "language"; language: AppLanguage }
  | {
      type: "status";
      freshness: FreshnessInfo;
      warnings: WarningInfo;
      rateLimit?: RateLimitInfo;          // Req 14.4
      claudeRateLimit?: ClaudeRateLimitInfo;
      codexUsageCache?: UsageCacheInfo;
      claudeUsageCache?: UsageCacheInfo;
      codexPlan?: UsagePlanInfo;
      claudePlan?: UsagePlanInfo;
      currency?: DisplayCurrencyConfig;   // Req 6.5
      analytics?: AnalyticsThresholds;    // Req 11.15, 14.3
      /** Ingestion worker health, so the UI can say why data stopped updating. */
      workerHealth?: WorkerHealthInfo;
    };
