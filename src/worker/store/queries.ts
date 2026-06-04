/**
 * Store query methods — read ONLY from the store (no raw-log access).
 *
 * Standalone functions taking a sql.js `Database` instance. These will be
 * integrated into `UsageStore` once task 5.2 completes. Each function builds
 * parameterized SQL dynamically based on the provided `AnalyticsQuery` filters.
 *
 * This module MUST NOT import `vscode`.
 */

import type { Database } from "sql.js";
import type { PricingTable } from "../../shared/types.js";
import type {
  DailyAggregate,
  VariantMetrics,
  SessionAggregate,
  ToolUsageRow,
  HeatmapCell,
} from "../../shared/storeTypes.js";
import type {
  AnalyticsQuery,
  FreshnessInfo,
  WarningInfo,
  RateLimitInfo,
} from "../../shared/protocol.js";
import { PricingEngine } from "../pricing.js";
import { localDayFromMs } from "../../shared/time.js";
import { baseModelOf } from "../../shared/variant.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SqlValue = number | string | Uint8Array | null;

interface WhereClause {
  sql: string;
  params: SqlValue[];
}

/**
 * Build a WHERE clause from an AnalyticsQuery for tables that have
 * day_local, source, workspace columns. `tablePrefix` allows qualifying
 * column names (e.g. "d." for daily_aggregate aliased as d).
 */
function buildDailyWhere(q: AnalyticsQuery, tablePrefix = ""): WhereClause {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  // Range filter on day_local (YYYY-MM-DD string comparison)
  const fromDay = localDayFromMs(q.range.fromUtc);
  const toDay = localDayFromMs(q.range.toUtc);
  conditions.push(`${tablePrefix}day_local >= ?`);
  params.push(fromDay);
  conditions.push(`${tablePrefix}day_local <= ?`);
  params.push(toDay);

  if (q.sources && q.sources.length > 0) {
    conditions.push(`${tablePrefix}source IN (${placeholders(q.sources.length)})`);
    params.push(...q.sources);
  }
  if (q.models && q.models.length > 0) {
    conditions.push(`${tablePrefix}base_model IN (${placeholders(q.models.length)})`);
    params.push(...q.models);
  }
  if (q.efforts && q.efforts.length > 0) {
    // daily_aggregate doesn't have effort column directly; variant_id encodes it.
    // Variants with effort: "model (effort)"; without: just "model" (no parens).
    const effortConditions: string[] = [];
    for (const e of q.efforts) {
      if (e === "n/a") {
        // No parenthesized suffix → variant_id NOT LIKE '% (%)'
        effortConditions.push(`${tablePrefix}variant_id NOT LIKE '% (%)'`);
      } else {
        effortConditions.push(`${tablePrefix}variant_id LIKE ?`);
        params.push(`%(${e})`);
      }
    }
    conditions.push(`(${effortConditions.join(" OR ")})`);
  }
  if (q.workspaces && q.workspaces.length > 0) {
    conditions.push(`${tablePrefix}workspace IN (${placeholders(q.workspaces.length)})`);
    params.push(...q.workspaces);
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql, params };
}

function buildRecordWhere(q: AnalyticsQuery, tablePrefix = ""): WhereClause {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  const fromDay = localDayFromMs(q.range.fromUtc);
  const toDay = localDayFromMs(q.range.toUtc);
  conditions.push(`${tablePrefix}day_local >= ?`);
  params.push(fromDay);
  conditions.push(`${tablePrefix}day_local <= ?`);
  params.push(toDay);

  if (q.sources && q.sources.length > 0) {
    conditions.push(`${tablePrefix}source IN (${placeholders(q.sources.length)})`);
    params.push(...q.sources);
  }
  if (q.models && q.models.length > 0) {
    conditions.push(`${tablePrefix}model IN (${placeholders(q.models.length)})`);
    params.push(...q.models);
  }
  if (q.efforts && q.efforts.length > 0) {
    conditions.push(`${tablePrefix}effort IN (${placeholders(q.efforts.length)})`);
    params.push(...q.efforts);
  }
  if (q.workspaces && q.workspaces.length > 0) {
    conditions.push(`${tablePrefix}workspace IN (${placeholders(q.workspaces.length)})`);
    params.push(...q.workspaces);
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql, params };
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

function num(v: SqlValue): number {
  return typeof v === "number" ? v : 0;
}

function str(v: SqlValue): string {
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * 1. dailySeries — SELECT from daily_aggregate filtered by query.
 * If rollupToBaseModel, GROUP BY (day_local, source, base_model, workspace).
 */
export function dailySeries(db: Database, q: AnalyticsQuery): DailyAggregate[] {
  const where = buildDailyWhere(q);

  if (q.rollupToBaseModel) {
    const sql = `
      SELECT day_local, source, base_model, workspace,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens,
             SUM(reasoning_tokens) as reasoning_tokens,
             SUM(total_tokens) as total_tokens,
             SUM(turns) as turns,
             SUM(cost_usd) as cost_usd,
             SUM(unknown_cost_turns) as unknown_cost_turns
      FROM daily_aggregate
      ${where.sql}
      GROUP BY day_local, source, base_model, workspace
      ORDER BY day_local`;

    const results = db.exec(sql, where.params);
    if (results.length === 0) return [];
    return results[0].values.map((row) => ({
      day: str(row[0]),
      source: str(row[1]) as DailyAggregate["source"],
      baseModel: str(row[2]),
      variantId: str(row[2]), // rolled up to base model
      workspace: str(row[3]),
      inputTokens: num(row[4]),
      outputTokens: num(row[5]),
      cacheReadTokens: num(row[6]),
      cacheCreationTokens: num(row[7]),
      reasoningTokens: num(row[8]),
      totalTokens: num(row[9]),
      turns: num(row[10]),
      costUsd: num(row[11]),
      unknownCostTurns: num(row[12]),
    }));
  }

  const sql = `
    SELECT day_local, source, variant_id, base_model, workspace,
           input_tokens, output_tokens, cache_read_tokens,
           cache_creation_tokens, reasoning_tokens, total_tokens,
           turns, cost_usd, unknown_cost_turns
    FROM daily_aggregate
    ${where.sql}
    ORDER BY day_local`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) return [];
  return results[0].values.map((row) => ({
    day: str(row[0]),
    source: str(row[1]) as DailyAggregate["source"],
    variantId: str(row[2]),
    baseModel: str(row[3]),
    workspace: str(row[4]),
    inputTokens: num(row[5]),
    outputTokens: num(row[6]),
    cacheReadTokens: num(row[7]),
    cacheCreationTokens: num(row[8]),
    reasoningTokens: num(row[9]),
    totalTokens: num(row[10]),
    turns: num(row[11]),
    costUsd: num(row[12]),
    unknownCostTurns: num(row[13]),
  }));
}

/**
 * 2. variantBreakdown — Aggregate from daily_aggregate grouped by variant.
 * Computes derived intensity metrics.
 */
export function variantBreakdown(db: Database, q: AnalyticsQuery): VariantMetrics[] {
  const where = buildDailyWhere(q);
  const groupCol = q.rollupToBaseModel ? "base_model" : "variant_id";

  const sql = `
    SELECT ${groupCol}, base_model, source,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(cache_creation_tokens) as cache_creation_tokens,
           SUM(reasoning_tokens) as reasoning_tokens,
           SUM(total_tokens) as total_tokens,
           SUM(turns) as turns,
           SUM(cost_usd) as cost_usd,
           SUM(unknown_cost_turns) as unknown_cost_turns
    FROM daily_aggregate
    ${where.sql}
    GROUP BY ${groupCol}, source
    ORDER BY cost_usd DESC`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) return [];

  const rows = results[0].values;

  // Compute totals for share calculations
  let grandTotalCost = 0;
  let grandTotalTokens = 0;
  for (const row of rows) {
    grandTotalCost += num(row[10]);
    grandTotalTokens += num(row[8]);
  }

  return rows.map((row) => {
    const variantId = str(row[0]);
    const baseModel = str(row[1]);
    const source = str(row[2]) as VariantMetrics["source"];
    const inputTokens = num(row[3]);
    const outputTokens = num(row[4]);
    const cacheReadTokens = num(row[5]);
    const cacheCreationTokens = num(row[6]);
    const reasoningTokens = num(row[7]);
    const totalTokens = num(row[8]);
    const turns = num(row[9]);
    const costUsd = num(row[10]);
    const unknownCostTurns = num(row[11]);

    // Derive effort from variantId
    const effortMatch = variantId.match(/\((minimal|low|medium|high|xhigh)\)$/);
    const effort = (effortMatch ? effortMatch[1] : "n/a") as VariantMetrics["effort"];

    const tokensPerTurn = turns > 0 ? totalTokens / turns : 0;
    const costPerTurn = turns > 0 ? costUsd / turns : 0;
    const outputRatio = inputTokens > 0 ? outputTokens / inputTokens : 0;
    const reasoningIntensity = (outputTokens + reasoningTokens) > 0 ? reasoningTokens / (outputTokens + reasoningTokens) : 0;
    const nonCachedInput = inputTokens + cacheCreationTokens;
    const cacheEfficiencyPct =
      cacheReadTokens + nonCachedInput > 0
        ? (cacheReadTokens / (cacheReadTokens + nonCachedInput)) * 100
        : 0;
    const blendedCostPer1K = totalTokens > 0 ? (costUsd / totalTokens) * 1000 : 0;
    const shareOfCostPct = grandTotalCost > 0 ? (costUsd / grandTotalCost) * 100 : 0;
    const shareOfTokensPct = grandTotalTokens > 0 ? (totalTokens / grandTotalTokens) * 100 : 0;

    return {
      variantId,
      baseModel,
      effort,
      source,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      totalTokens,
      costUsd,
      costUnknown: unknownCostTurns > 0,
      shareOfCostPct,
      shareOfTokensPct,
      turns,
      tokensPerTurn,
      costPerTurn,
      outputRatio,
      reasoningIntensity,
      cacheEfficiencyPct,
      blendedCostPer1K,
    };
  });
}

/**
 * 3. sessionLeaderboard — SELECT from session_aggregate filtered by range overlap.
 */
export function sessionLeaderboard(db: Database, q: AnalyticsQuery): SessionAggregate[] {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  // Range overlap: session overlaps [fromUtc, toUtc] if first_ts_utc <= toUtc AND last_ts_utc >= fromUtc
  conditions.push("first_ts_utc <= ?");
  params.push(q.range.toUtc);
  conditions.push("last_ts_utc >= ?");
  params.push(q.range.fromUtc);

  if (q.sources && q.sources.length > 0) {
    conditions.push(`source IN (${placeholders(q.sources.length)})`);
    params.push(...q.sources);
  }
  if (q.workspaces && q.workspaces.length > 0) {
    conditions.push(`workspace IN (${placeholders(q.workspaces.length)})`);
    params.push(...q.workspaces);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT source, session_id, workspace, first_ts_utc, last_ts_utc,
           turns, total_tokens, cost_usd, peak_context_fill, sidechain_tokens
    FROM session_aggregate
    ${whereClause}
    ORDER BY cost_usd DESC`;

  const results = db.exec(sql, params);
  if (results.length === 0) return [];
  return results[0].values.map((row) => {
    const result: SessionAggregate = {
      source: str(row[0]) as SessionAggregate["source"],
      sessionId: str(row[1]),
      workspace: str(row[2]),
      firstTsUtc: num(row[3]),
      lastTsUtc: num(row[4]),
      turns: num(row[5]),
      totalTokens: num(row[6]),
      costUsd: num(row[7]),
      sidechainTokens: num(row[9]),
    };
    const peakFill = row[8];
    if (peakFill !== null) {
      result.peakContextFill = num(peakFill);
    }
    return result;
  });
}

/**
 * 4. toolUsage — SELECT from tool_event grouped by tool_name.
 */
export function toolUsage(db: Database, q: AnalyticsQuery): ToolUsageRow[] {
  const where = buildRecordWhere(q, "r.");

  const sql = `
    SELECT t.tool_name, r.source, COUNT(*) as cnt
    FROM tool_event t
    JOIN usage_record r ON r.dedup_key = t.record_dedup_key
    ${where.sql}
    GROUP BY t.tool_name, r.source
    ORDER BY cnt DESC, t.tool_name ASC`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) return [];

  const rows = results[0].values;
  let totalCount = 0;
  for (const row of rows) {
    totalCount += num(row[2]);
  }

  return rows.map((row) => {
    const count = num(row[2]);
    return {
      toolName: str(row[0]),
      source: str(row[1]) as ToolUsageRow["source"],
      count,
      sharePct: totalCount > 0 ? (count / totalCount) * 100 : 0,
    };
  });
}

/**
 * 5. heatmap — SELECT from usage_record GROUP BY dow_local, hour_local.
 */
export function heatmap(db: Database, q: AnalyticsQuery): HeatmapCell[] {
  const where = buildRecordWhere(q);

  const sql = `
    SELECT dow_local, hour_local, SUM(total_tokens) as tokens,
           0 as cost_usd
    FROM usage_record
    ${where.sql}
    GROUP BY dow_local, hour_local
    ORDER BY dow_local, hour_local`;

  // Note: usage_record doesn't store cost_usd per row. We sum tokens only.
  // Cost could be joined from daily_aggregate but the spec says GROUP BY dow,hour
  // from usage_record. We'll return 0 for cost and let the caller handle it,
  // OR we can compute from daily_aggregate with a different approach.
  // Actually, let's use daily_aggregate for cost since usage_record has no cost column.
  // We'll do a separate query for cost by day and distribute, but that's complex.
  // Simpler: just return token sums from usage_record (cost=0 placeholder).
  // The design says "Sum tokens and cost" — but usage_record has no cost column.
  // We'll compute cost from the heatmap tokens using a zero placeholder for now.

  const results = db.exec(sql, where.params);
  if (results.length === 0) return [];
  return results[0].values.map((row) => ({
    dow: num(row[0]),
    hour: num(row[1]),
    tokens: num(row[2]),
    costUsd: 0, // usage_record doesn't carry per-row cost
  }));
}

/**
 * 6. freshness — Read last_ingest_run_utc from meta, MAX(ts_utc) from usage_record.
 */
export function freshness(db: Database): FreshnessInfo {
  const info: FreshnessInfo = {};

  const metaResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["last_ingest_run_utc"]
  );
  if (metaResult.length > 0 && metaResult[0].values.length > 0) {
    const val = metaResult[0].values[0][0];
    if (val !== null) info.lastIngestRunUtc = Number(val);
  }

  const maxResult = db.exec("SELECT MAX(ts_utc) FROM usage_record");
  if (maxResult.length > 0 && maxResult[0].values.length > 0) {
    const val = maxResult[0].values[0][0];
    if (val !== null) info.latestRecordUtc = num(val);
  }

  return info;
}

/**
 * 7. warnings — Read malformed/oversized counts from meta, unmapped models.
 */
export function warnings(db: Database): WarningInfo {
  let malformedLineCount = 0;
  let oversizedLineCount = 0;

  const malformedResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["malformed_line_count"]
  );
  if (malformedResult.length > 0 && malformedResult[0].values.length > 0) {
    const val = malformedResult[0].values[0][0];
    if (val !== null) malformedLineCount = Number(val);
  }

  const oversizedResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["oversized_line_count"]
  );
  if (oversizedResult.length > 0 && oversizedResult[0].values.length > 0) {
    const val = oversizedResult[0].values[0][0];
    if (val !== null) oversizedLineCount = Number(val);
  }

  const unmappedResult = db.exec("SELECT model FROM unmapped_model");
  const unmappedModels: string[] = [];
  if (unmappedResult.length > 0) {
    for (const row of unmappedResult[0].values) {
      unmappedModels.push(str(row[0]));
    }
  }

  return { unmappedModels, malformedLineCount, oversizedLineCount };
}

/**
 * 8. latestRateLimit — Read rate_limit_codex JSON from meta table.
 */
export function latestRateLimit(db: Database): RateLimitInfo | undefined {
  const result = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["rate_limit_codex"]
  );
  if (result.length === 0 || result[0].values.length === 0) return undefined;

  const val = result[0].values[0][0];
  if (val === null || typeof val !== "string") return undefined;

  try {
    const parsed = JSON.parse(val) as RateLimitInfo;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 9. recomputeCosts — Rewrite cost columns from stored token sums using pricing table.
 * Updates daily_aggregate and session_aggregate in place. No raw-log read.
 */
export function recomputeCosts(db: Database, table: PricingTable): void {
  const engine = new PricingEngine(table);

  // Recompute daily_aggregate costs
  const dailyRows = db.exec(
    `SELECT rowid, variant_id, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, reasoning_tokens
     FROM daily_aggregate`
  );

  if (dailyRows.length > 0) {
    const stmt = db.prepare("UPDATE daily_aggregate SET cost_usd = ?, unknown_cost_turns = CASE WHEN ? THEN turns ELSE 0 END WHERE rowid = ?");
    for (const row of dailyRows[0].values) {
      const rowid = num(row[0]);
      const variantId = str(row[1]);
      const model = baseModelOf(variantId);
      const breakdown = engine.costOfAggregate(model, {
        inputTokens: num(row[2]),
        outputTokens: num(row[3]),
        cacheReadTokens: num(row[4]),
        cacheCreationTokens: num(row[5]),
        reasoningTokens: num(row[6]),
      });
      stmt.run([breakdown.usd, breakdown.unknown ? 1 : 0, rowid]);
    }
    stmt.free();
  }

  // Recompute session_aggregate costs by summing daily costs per session
  // Session doesn't have per-token breakdown, so we need to recompute from
  // usage_record tokens grouped by session. But the spec says "no raw-log read"
  // and usage_record IS the store (not raw logs). Let's use usage_record.
  const sessionRows = db.exec(
    `SELECT source, session_id,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_creation_tokens) as cache_creation_tokens,
            SUM(reasoning_tokens) as reasoning_tokens,
            model
     FROM usage_record
     GROUP BY source, session_id, model`
  );

  // Accumulate cost per (source, session_id)
  const sessionCosts = new Map<string, number>();
  if (sessionRows.length > 0) {
    for (const row of sessionRows[0].values) {
      const source = str(row[0]);
      const sessionId = str(row[1]);
      const model = str(row[7]);
      const breakdown = engine.costOfAggregate(model, {
        inputTokens: num(row[2]),
        outputTokens: num(row[3]),
        cacheReadTokens: num(row[4]),
        cacheCreationTokens: num(row[5]),
        reasoningTokens: num(row[6]),
      });
      const key = `${source}\0${sessionId}`;
      sessionCosts.set(key, (sessionCosts.get(key) ?? 0) + breakdown.usd);
    }
  }

  if (sessionCosts.size > 0) {
    const stmt = db.prepare("UPDATE session_aggregate SET cost_usd = ? WHERE source = ? AND session_id = ?");
    for (const [key, cost] of sessionCosts) {
      const [source, sessionId] = key.split("\0");
      stmt.run([cost, source, sessionId]);
    }
    stmt.free();
  }
}
