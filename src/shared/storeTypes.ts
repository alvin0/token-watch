/**
 * Persistence / row / value types shared by the store, analytics service, and
 * message protocols. This module carries two kinds of shapes:
 *   - AGGREGATED result rows returned to the WebView (never raw logs, Req 8.5):
 *     DailyAggregate, VariantMetrics, SessionAggregate, ToolUsageRow, HeatmapCell.
 *   - PERSISTENCE / ingest values used by the store and worker (Req 4.4, 4.19):
 *     FileCursor, FileContribution, StoreBatch.
 *
 * This module MUST NOT import `vscode`.
 */

import {
  Source,
  Effort,
  TokenSums,
  CumulativeTotals,
  UsageRecord,
  ToolEvent,
} from "./types";

/** One daily rollup row per (day, source, variant, workspace) (Req 4.20, 5.1). */
export interface DailyAggregate extends TokenSums {
  day: string;            // local calendar day, "YYYY-MM-DD"
  source: Source;
  variantId: string;
  baseModel: string;
  workspace: string;
  totalTokens: number;
  turns: number;
  costUsd: number;
  unknownCostTurns: number;
}

/** Derived per-variant intensity metrics (Req 7.4–7.9). */
export interface VariantMetrics extends TokenSums {
  variantId: string;
  baseModel: string;
  effort: Effort;
  source: Source;
  totalTokens: number;
  costUsd: number;
  costUnknown: boolean;
  shareOfCostPct: number;
  shareOfTokensPct: number;
  turns: number;
  tokensPerTurn: number;
  costPerTurn: number;
  outputRatio: number;          // output / input (Req 7.6)
  reasoningIntensity: number;   // reasoning / output (Req 7.7)
  cacheEfficiencyPct: number;   // cacheRead / (cacheRead + non-cached input) (Req 7.8)
  blendedCostPer1K: number;     // cost / total * 1000 (Req 7.9)
}

/** Session-level rollup for leaderboard / health (Req 11.16, 14.2). */
export interface SessionAggregate {
  source: Source;
  sessionId: string;
  workspace: string;
  firstTsUtc: number;
  lastTsUtc: number;
  turns: number;
  totalTokens: number;
  costUsd: number;
  peakContextFill?: number;     // max over turns of context_used / context_window (Req 14.1/3)
  sidechainTokens: number;      // Req 13.3
}

/** One row per tool name (optionally split by sidechain) (Req 13.1). */
export interface ToolUsageRow {
  toolName: string;
  source: Source;
  count: number;
  sharePct: number;
  isSidechain?: boolean;
}

/** Daily tool-call count used by current-period summaries. */
export interface ToolCallsByDay {
  day: string;
  count: number;
}

/** One cell of the local day-of-week × hour activity heatmap (Req 11.13). */
export interface HeatmapCell {
  dow: number;        // 0–6, local day of week
  hour: number;       // 0–23, local hour
  tokens: number;
  costUsd: number;
}

/**
 * Per-file incremental scan cursor (Req 4.4). Lets the scanner decide skip /
 * append / re-ingest for a file without re-reading it (Req 4.6–4.10) and lets
 * append-mode parsing resume cumulative state mid-file (Req 4.11/4.12).
 */
export interface FileCursor {
  filePath: string;
  fileId: string;
  source: Source;
  size: number;
  mtimeMs: number;
  lastByteOffset: number;
  headHash: string;                // hash of first N bytes — rotation/rewrite guard (Req 4.9)
  tailAnchorHash: string;          // hash of the W bytes ending exactly at lastByteOffset — append guard (Req 4.8)
  runningTotals: Record<string, CumulativeTotals>;
  recentRequestIds: string[];
  contribution: FileContribution;
}

/** Exactly what this file added, so re-ingest can subtract it (Req 4.10). */
export interface FileContribution {
  daily: Array<{ day: string; source: Source; variantId: string; workspace: string;
                 sums: TokenSums; turns: number; costUsd: number; unknownTurns: number }>;
  sessions: Array<{ source: Source; sessionId: string; sums: TokenSums;
                    turns: number; costUsd: number;
                    firstTsUtc: number; lastTsUtc: number; sidechainTokens: number }>;
  recordKeys: string[];            // dedup_keys to delete
  toolEventCount: number;
}

/**
 * The per-file ingest payload consumed by `UsageStore.applyFileResult(fileId,
 * batch)` (Req 2.8, 4.19). The worker computes one of these per file and the
 * store applies it in a single transaction: it upserts each `UsageRecord` row
 * by `dedupKey` (replace semantics) and each `ToolEvent`, then folds in the
 * already-rolled-up aggregate deltas carried by `contribution`.
 *
 * Cost handling: costs are computed in the worker via the PricingEngine BEFORE
 * this batch is built, so the rolled-up cost deltas live on
 * `contribution.daily[].costUsd` / `contribution.sessions[].costUsd` (and the
 * unknown-cost turn counts on `contribution.daily[].unknownTurns`). The
 * `records` carry token data only; the store does not recompute per-record cost
 * on ingest. This keeps `StoreBatch` minimal and avoids duplicating cost on
 * both the records and the contribution. `contribution` is also persisted onto
 * the `FileCursor` so a later re-ingest can subtract exactly what was added
 * (Req 4.10).
 */
export interface StoreBatch {
  records: UsageRecord[];
  toolEvents: ToolEvent[];
  contribution: FileContribution;
}
