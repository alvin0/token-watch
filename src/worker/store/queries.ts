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
  ToolCallsByDay,
  HourlyAggregate,
  HeatmapCell,
} from "../../shared/storeTypes.js";
import type {
  AnalyticsQuery,
  FreshnessInfo,
  WarningInfo,
  RateLimitInfo,
} from "../../shared/protocol.js";
import { PricingEngine } from "../pricing.js";
import { localDayFromMs, parseLocalDay } from "../../shared/time.js";
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

/**
 * Whether the tool tables can answer a query without joining `usage_record`.
 *
 * `tool_event` carries its own `day_local` and `source`, and is indexed on the
 * pair, so a query filtered on nothing else can be read straight from it. It
 * does NOT carry a usable model, effort or workspace — the commit path writes
 * those blank — so any filter on one of those still needs the join.
 *
 * Worth the branch: joining 20,630 tool events to 162,742 records took 77 ms
 * per query on a real database, and the two tool queries between them were 87%
 * of the time the dashboard spent reading.
 */
function toolsAnswerableDirectly(q: AnalyticsQuery): boolean {
  return (q.models?.length ?? 0) === 0
    && (q.efforts?.length ?? 0) === 0
    && (q.workspaces?.length ?? 0) === 0;
}

/** Day-and-source filter against whichever table carries those columns. */
function buildToolWhere(q: AnalyticsQuery, prefix: string): WhereClause {
  const conditions = [`${prefix}day_local >= ?`, `${prefix}day_local <= ?`];
  const params: SqlValue[] = [localDayFromMs(q.range.fromUtc), localDayFromMs(q.range.toUtc)];
  if (q.sources && q.sources.length > 0) {
    conditions.push(`${prefix}source IN (${placeholders(q.sources.length)})`);
    params.push(...q.sources);
  }
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
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

function sessionModelKey(source: string, sessionId: string, model: string): string {
  return `${source}\0${sessionId}\0${model}`;
}

function longContextSessionModelKeys(db: Database, pricing: PricingEngine): Set<string> {
  const keys = new Set<string>();
  const rows = db.exec(
    `SELECT source, session_id, model, MAX(context_used_tokens) as max_context_used_tokens
     FROM usage_record
     WHERE context_used_tokens IS NOT NULL
     GROUP BY source, session_id, model`
  );
  if (rows.length === 0) {
    return keys;
  }
  for (const row of rows[0].values) {
    const source = str(row[0]);
    const sessionId = str(row[1]);
    const model = str(row[2]);
    const contextUsed = num(row[3]);
    const status = pricing.longContextStatus(model, contextUsed);
    if (status.applied) {
      keys.add(sessionModelKey(source, sessionId, model));
    }
  }
  return keys;
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
    if (results.length === 0) {
      return [];
    }
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
  if (results.length === 0) {
    return [];
  }
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
  if (results.length === 0) {
    return [];
  }

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
    const effortMatch = variantId.match(/\((minimal|low|medium|high|xhigh|ultra|max)\)$/);
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
/**
 * Sessions ordered by peak context fill rather than cost.
 *
 * The cost leaderboard is truncated before it reaches the UI, so a session that
 * nearly filled its context window but cost little was invisible to the context
 * warning. This orders by the property being warned about.
 */
export function sessionsByContextFill(db: Database, q: AnalyticsQuery, limit = 20): SessionAggregate[] {
  return sessionLeaderboard(db, q, "peak_context_fill DESC, total_tokens DESC", limit);
}

/**
 * NOTE ON SEMANTICS: rows are whole sessions selected by OVERLAP with the
 * range, so a session that straddles the boundary contributes its full totals,
 * not just the part inside the window. `session_aggregate` has no model or
 * effort column, so those filters SELECT the matching sessions (via the
 * records that belong to them) but cannot narrow each session's totals. This
 * is why the daily series, not this, is the source of truth for period totals.
 *
 * `limit` is applied in SQL: loading every session to slice twenty grew with
 * total history rather than with what is shown.
 */
export function sessionLeaderboard(
  db: Database,
  q: AnalyticsQuery,
  orderBy = "cost_usd DESC",
  limit?: number,
): SessionAggregate[] {
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
  // Model and effort live on the records, not the session rollup. Selecting
  // through them at least stops a filtered view listing sessions that contain
  // none of the chosen models.
  if (q.models && q.models.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM usage_record ur
               WHERE ur.source = session_aggregate.source
                 AND ur.session_id = session_aggregate.session_id
                 AND ur.model IN (${placeholders(q.models.length)}))`,
    );
    params.push(...q.models);
  }
  if (q.efforts && q.efforts.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM usage_record ur
               WHERE ur.source = session_aggregate.source
                 AND ur.session_id = session_aggregate.session_id
                 AND ur.effort IN (${placeholders(q.efforts.length)}))`,
    );
    params.push(...q.efforts);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT source, session_id, workspace, first_ts_utc, last_ts_utc,
           turns, total_tokens, cost_usd, peak_context_fill, sidechain_tokens
    FROM session_aggregate
    ${whereClause}
    ORDER BY ${orderBy}
    ${typeof limit === "number" ? `LIMIT ${Math.max(0, Math.floor(limit))}` : ""}`;

  const results = db.exec(sql, params);
  if (results.length === 0) {
    return [];
  }
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
  const direct = toolsAnswerableDirectly(q);
  const where = direct ? buildToolWhere(q, "t.") : buildRecordWhere(q, "r.");

  const sql = direct
    ? `
    SELECT t.tool_name, t.source, COUNT(*) as cnt
    FROM tool_event t
    ${where.sql}
    GROUP BY t.tool_name, t.source
    ORDER BY cnt DESC, t.tool_name ASC`
    : `
    SELECT t.tool_name, r.source, COUNT(*) as cnt
    FROM tool_event t
    JOIN usage_record r ON r.dedup_key = t.record_dedup_key
    ${where.sql}
    GROUP BY t.tool_name, r.source
    ORDER BY cnt DESC, t.tool_name ASC`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) {
    return [];
  }

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

export function toolCallsByDay(db: Database, q: AnalyticsQuery): ToolCallsByDay[] {
  const direct = toolsAnswerableDirectly(q);
  const where = direct ? buildToolWhere(q, "t.") : buildRecordWhere(q, "r.");

  const sql = direct
    ? `
    SELECT t.day_local, COUNT(*) as cnt
    FROM tool_event t
    ${where.sql}
    GROUP BY t.day_local
    ORDER BY t.day_local`
    : `
    SELECT r.day_local, COUNT(*) as cnt
    FROM tool_event t
    JOIN usage_record r ON r.dedup_key = t.record_dedup_key
    ${where.sql}
    GROUP BY r.day_local
    ORDER BY r.day_local`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) {
    return [];
  }

  return results[0].values.map((row) => ({
    day: str(row[0]),
    count: num(row[1]),
  }));
}

export function hourlySeries(db: Database, q: AnalyticsQuery, pricing: PricingEngine): HourlyAggregate[] {
  const where = buildRecordWhere(q);
  void pricing;

  const sql = `
    SELECT day_local, hour_local, model, source, session_id,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(cache_creation_tokens) as cache_creation_tokens,
           SUM(reasoning_tokens) as reasoning_tokens,
           SUM(total_tokens) as total_tokens,
           COUNT(*) as turns,
           SUM(cost_usd) as cost_usd,
           SUM(cost_unknown) as unknown_cost_turns
    FROM usage_record
    ${where.sql}
    GROUP BY day_local, hour_local, model, source, session_id
    ORDER BY day_local, hour_local`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) {
    return [];
  }

  const buckets = new Map<string, HourlyAggregate>();
  for (const row of results[0].values) {
    const day = str(row[0]);
    const hour = num(row[1]);
    const key = `${day}\0${hour}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        day,
        hour,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        turns: 0,
        costUsd: 0,
        unknownCostTurns: 0,
      };
      buckets.set(key, bucket);
    }

    const sums = {
      inputTokens: num(row[5]),
      outputTokens: num(row[6]),
      cacheReadTokens: num(row[7]),
      cacheCreationTokens: num(row[8]),
      reasoningTokens: num(row[9]),
    };
    const turns = num(row[11]);
    bucket.inputTokens += sums.inputTokens;
    bucket.outputTokens += sums.outputTokens;
    bucket.cacheReadTokens += sums.cacheReadTokens;
    bucket.cacheCreationTokens += sums.cacheCreationTokens;
    bucket.reasoningTokens += sums.reasoningTokens;
    bucket.totalTokens += num(row[10]);
    bucket.turns += turns;
    bucket.costUsd += num(row[12]);
    bucket.unknownCostTurns += num(row[13]);
  }

  return Array.from(buckets.values()).sort((a, b) => (
    a.day === b.day ? a.hour - b.hour : a.day.localeCompare(b.day)
  ));
}

/**
 * 5. heatmap — SELECT from usage_record GROUP BY dow_local, hour_local.
 */
export function heatmap(db: Database, q: AnalyticsQuery): HeatmapCell[] {
  const where = buildRecordWhere(q);

  const sql = `
    SELECT dow_local, hour_local, SUM(total_tokens) as tokens,
           SUM(cost_usd) as cost_usd
    FROM usage_record
    ${where.sql}
    GROUP BY dow_local, hour_local
    ORDER BY dow_local, hour_local`;

  const results = db.exec(sql, where.params);
  if (results.length === 0) {
    return [];
  }
  return results[0].values.map((row) => ({
    dow: num(row[0]),
    hour: num(row[1]),
    tokens: num(row[2]),
    costUsd: num(row[3]),
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
    if (val !== null) {
      info.lastIngestRunUtc = Number(val);
    }
  }

  const maxResult = db.exec("SELECT MAX(ts_utc) FROM usage_record");
  if (maxResult.length > 0 && maxResult[0].values.length > 0) {
    const val = maxResult[0].values[0][0];
    if (val !== null) {
      info.latestRecordUtc = num(val);
    }
  }

  return info;
}

/**
 * 7. warnings — Read malformed/oversized counts from meta, unmapped models.
 */
export function warnings(db: Database): WarningInfo {
  let malformedLineCount = 0;
  let oversizedLineCount = 0;
  let lostUsageLineCount = 0;

  const malformedResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["malformed_line_count"]
  );
  if (malformedResult.length > 0 && malformedResult[0].values.length > 0) {
    const val = malformedResult[0].values[0][0];
    if (val !== null) {
      malformedLineCount = Number(val);
    }
  }

  const oversizedResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["oversized_line_count"]
  );
  if (oversizedResult.length > 0 && oversizedResult[0].values.length > 0) {
    const val = oversizedResult[0].values[0][0];
    if (val !== null) {
      oversizedLineCount = Number(val);
    }
  }

  const unmappedResult = db.exec("SELECT model FROM unmapped_model");
  const unmappedModels: string[] = [];
  if (unmappedResult.length > 0) {
    for (const row of unmappedResult[0].values) {
      unmappedModels.push(str(row[0]));
    }
  }

  const lostUsageResult = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["lost_usage_line_count"],
  );
  if (lostUsageResult.length > 0 && lostUsageResult[0].values.length > 0) {
    const value = lostUsageResult[0].values[0][0];
    if (value !== null) {
      lostUsageLineCount = Number(value);
    }
  }

  return { unmappedModels, malformedLineCount, oversizedLineCount, lostUsageLineCount };
}

/**
 * 8. latestRateLimit — Read rate_limit_codex JSON from meta table.
 */
export function latestRateLimit(db: Database): RateLimitInfo | undefined {
  const result = db.exec(
    "SELECT value FROM meta WHERE key = ?",
    ["rate_limit_codex"]
  );
  if (result.length === 0 || result[0].values.length === 0) {
    return undefined;
  }

  const val = result[0].values[0][0];
  if (val === null || typeof val !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(val) as RateLimitInfo;
    return parsed;
  } catch {
    return undefined;
  }
}

export function repriceAllRecords(
  db: Database,
  pricing: PricingEngine,
  manageTransaction = true,
): void {
  const longContextKeys = longContextSessionModelKeys(db, pricing);
  const result = db.exec(
    `SELECT dedup_key, source, session_id, model,
            input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, reasoning_tokens
     FROM usage_record`,
  );
  if (result.length === 0) { return; }

  const update = db.prepare(
    "UPDATE usage_record SET cost_usd = ?, cost_unknown = ? WHERE dedup_key = ?",
  );
  if (manageTransaction) { db.run("BEGIN TRANSACTION"); }
  try {
    for (const row of result[0].values) {
      const source = str(row[1]);
      const sessionId = str(row[2]);
      const model = str(row[3]);
      const cost = pricing.costOfAggregate(model, {
        inputTokens: num(row[4]),
        outputTokens: num(row[5]),
        cacheReadTokens: num(row[6]),
        cacheCreationTokens: num(row[7]),
        reasoningTokens: num(row[8]),
      }, {
        forceLongContext: longContextKeys.has(sessionModelKey(source, sessionId, model)),
      });
      update.run([cost.usd, cost.unknown ? 1 : 0, str(row[0])]);
    }
    if (manageTransaction) { db.run("COMMIT"); }
  } catch (error) {
    if (manageTransaction) { db.run("ROLLBACK"); }
    throw error;
  } finally {
    update.free();
  }
}

export interface AggregateIntegrityResult {
  valid: boolean;
  recordTurns: number;
  dailyTurns: number;
  sessionTurns: number;
  recordTokens: number;
  dailyTokens: number;
  sessionTokens: number;
  dailyCost: number;
  sessionCost: number;
  recordUnknownTurns: number;
  dailyUnknownTurns: number;
}

export function aggregateIntegrity(db: Database): AggregateIntegrityResult {
  // Retention deletes raw rows but deliberately keeps the aggregates derived
  // from them, so beyond the watermark there is nothing left to cross-check
  // against. Comparing the whole tables would report a healthy database as
  // corrupt forever, and the worker answers that by rebuilding aggregates on
  // every single scan.
  const watermark = retainedFromDay(db);
  const since = watermark === undefined ? undefined : parseLocalDay(watermark).getTime();
  const dayFilter = watermark === undefined ? "" : " WHERE day_local >= ?";
  const dayArgs = watermark === undefined ? [] : [watermark];
  const sessionFilter = since === undefined ? "" : " WHERE first_ts_utc >= ?";
  const sessionArgs = since === undefined ? [] : [since];

  const record = db.exec(
    `SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_unknown), 0)
     FROM usage_record`,
  )[0]?.values[0] ?? [0, 0, 0];
  const daily = db.exec(
    `SELECT COALESCE(SUM(turns), 0), COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(cost_usd), 0), COALESCE(SUM(unknown_cost_turns), 0)
     FROM daily_aggregate${dayFilter}`,
    dayArgs,
  )[0]?.values[0] ?? [0, 0, 0, 0];
  const session = db.exec(
    `SELECT COALESCE(SUM(turns), 0), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0)
     FROM session_aggregate${sessionFilter}`,
    sessionArgs,
  )[0]?.values[0] ?? [0, 0, 0];
  const result: AggregateIntegrityResult = {
    recordTurns: num(record[0]),
    recordTokens: num(record[1]),
    recordUnknownTurns: num(record[2]),
    dailyTurns: num(daily[0]),
    dailyTokens: num(daily[1]),
    dailyCost: num(daily[2]),
    dailyUnknownTurns: num(daily[3]),
    sessionTurns: num(session[0]),
    sessionTokens: num(session[1]),
    sessionCost: num(session[2]),
    valid: false,
  };
  result.valid =
    result.recordTurns === result.dailyTurns &&
    result.recordTurns === result.sessionTurns &&
    result.recordTokens === result.dailyTokens &&
    result.recordTokens === result.sessionTokens &&
    result.recordUnknownTurns === result.dailyUnknownTurns &&
    Math.abs(result.dailyCost - result.sessionCost) <= 1e-9;
  return result;
}

/**
 * The first local day that still has raw rows, or undefined if none were pruned.
 *
 * Read straight from meta rather than passed in, so no caller can rebuild
 * aggregates while unaware that the rows behind the older ones are gone.
 */
function retainedFromDay(db: Database): string | undefined {
  const result = db.exec("SELECT value FROM meta WHERE key = ?", ["raw_retained_from_day"]);
  const value = result[0]?.values[0]?.[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function rebuildAggregates(db: Database, pricing: PricingEngine): void {
  db.run("BEGIN TRANSACTION");
  try {
    repriceAllRecords(db, pricing, false);
    const dailyRows = db.exec(
    `SELECT day_local, source, variant_id, model, workspace,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_creation_tokens) as cache_creation_tokens,
            SUM(reasoning_tokens) as reasoning_tokens,
            SUM(total_tokens) as total_tokens,
            COUNT(*) as turns,
            SUM(cost_usd) as cost_usd,
            SUM(cost_unknown) as unknown_cost_turns
     FROM usage_record
     GROUP BY day_local, source, variant_id, model, workspace`
  );
    const sessionRows = db.exec(
    `SELECT source, session_id,
            MAX(CASE WHEN workspace != '' THEN workspace ELSE '' END) as workspace,
            MIN(ts_utc) as first_ts_utc,
            MAX(ts_utc) as last_ts_utc,
            COUNT(*) as turns,
            SUM(total_tokens) as total_tokens,
            SUM(CASE WHEN is_sidechain = 1 THEN total_tokens ELSE 0 END) as sidechain_tokens,
            SUM(cost_usd) as cost_usd
     FROM usage_record
     GROUP BY source, session_id`
  );

    // Only clear what the surviving raw rows can rebuild. Once retention has
    // pruned old days, their aggregates are the only remaining record of them;
    // clearing those unconditionally deleted the user's history for good, and
    // the next rebuild had nothing left to put back.
    const watermark = retainedFromDay(db);
    if (watermark === undefined) {
      db.run("DELETE FROM daily_aggregate");
      db.run("DELETE FROM session_aggregate");
    } else {
      db.run("DELETE FROM daily_aggregate WHERE day_local >= ?", [watermark]);
      // Pruning never splits a session, so every session that still has rows
      // started on or after the watermark. Anything that started earlier is
      // fully pruned and its stored row is all that is left of it.
      db.run(
        "DELETE FROM session_aggregate WHERE first_ts_utc >= ?",
        [parseLocalDay(watermark).getTime()],
      );
    }

    const dailyMap = new Map<string, {
      day: string;
      source: string;
      variantId: string;
      baseModel: string;
      workspace: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      turns: number;
      costUsd: number;
      unknownCostTurns: number;
    }>();

    if (dailyRows.length > 0) {
      for (const row of dailyRows[0].values) {
        const day = str(row[0]);
        const source = str(row[1]);
        const variantId = str(row[2]);
        const model = str(row[3]);
        const workspace = str(row[4]);
        const sums = {
          inputTokens: num(row[5]),
          outputTokens: num(row[6]),
          cacheReadTokens: num(row[7]),
          cacheCreationTokens: num(row[8]),
          reasoningTokens: num(row[9]),
        };
        const total = num(row[10]);
        const turns = num(row[11]);
        const costUsd = num(row[12]);
        const unknownTurns = num(row[13]);
        const key = `${day}\0${source}\0${variantId}\0${workspace}`;
        const existing = dailyMap.get(key);
        if (existing) {
          existing.inputTokens += sums.inputTokens;
          existing.outputTokens += sums.outputTokens;
          existing.cacheReadTokens += sums.cacheReadTokens;
          existing.cacheCreationTokens += sums.cacheCreationTokens;
          existing.reasoningTokens += sums.reasoningTokens;
          existing.totalTokens += total;
          existing.turns += turns;
          existing.costUsd += costUsd;
          existing.unknownCostTurns += unknownTurns;
        } else {
          dailyMap.set(key, {
            day,
            source,
            variantId,
            baseModel: model || baseModelOf(variantId),
            workspace,
            inputTokens: sums.inputTokens,
            outputTokens: sums.outputTokens,
            cacheReadTokens: sums.cacheReadTokens,
            cacheCreationTokens: sums.cacheCreationTokens,
            reasoningTokens: sums.reasoningTokens,
            totalTokens: total,
            turns,
            costUsd,
            unknownCostTurns: unknownTurns,
          });
        }
      }
    }

    if (dailyMap.size > 0) {
      const dailyStmt = db.prepare(
        `INSERT INTO daily_aggregate
         (day_local, source, variant_id, base_model, workspace,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          reasoning_tokens, total_tokens, turns, cost_usd, unknown_cost_turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const row of dailyMap.values()) {
        dailyStmt.run([
          row.day,
          row.source,
          row.variantId,
          row.baseModel,
          row.workspace,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheCreationTokens,
          row.reasoningTokens,
          row.totalTokens,
          row.turns,
          row.costUsd,
          row.unknownCostTurns,
        ]);
      }
      dailyStmt.free();
    }

    const sessions = new Map<string, {
      source: string;
      sessionId: string;
      workspace: string;
      firstTsUtc: number;
      lastTsUtc: number;
      turns: number;
      totalTokens: number;
      costUsd: number;
      sidechainTokens: number;
    }>();

    if (sessionRows.length > 0) {
      for (const row of sessionRows[0].values) {
        const source = str(row[0]);
        const sessionId = str(row[1]);
        const key = `${source}\0${sessionId}`;
        const costUsd = num(row[8]);
        const existing = sessions.get(key);
        if (existing) {
          existing.workspace = existing.workspace || str(row[2]);
          existing.firstTsUtc = Math.min(existing.firstTsUtc, num(row[3]));
          existing.lastTsUtc = Math.max(existing.lastTsUtc, num(row[4]));
          existing.turns += num(row[5]);
          existing.totalTokens += num(row[6]);
          existing.costUsd += costUsd;
          existing.sidechainTokens += num(row[7]);
        } else {
          sessions.set(key, {
            source,
            sessionId,
            workspace: str(row[2]),
            firstTsUtc: num(row[3]),
            lastTsUtc: num(row[4]),
            turns: num(row[5]),
            totalTokens: num(row[6]),
            costUsd,
            sidechainTokens: num(row[7]),
          });
        }
      }
    }

    if (sessions.size > 0) {
      const sessionStmt = db.prepare(
        `INSERT INTO session_aggregate
         (source, session_id, workspace, first_ts_utc, last_ts_utc,
          turns, total_tokens, cost_usd, sidechain_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const session of sessions.values()) {
        sessionStmt.run([
          session.source,
          session.sessionId,
          session.workspace,
          session.firstTsUtc,
          session.lastTsUtc,
          session.turns,
          session.totalTokens,
          session.costUsd,
          session.sidechainTokens,
        ]);
      }
      sessionStmt.free();
    }

    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/**
 * 9. recomputeCosts — Rewrite cost columns from stored token sums using pricing table.
 * Updates daily_aggregate and session_aggregate in place. No raw-log read.
 */
export function recomputeCosts(db: Database, table: PricingTable): void {
  rebuildAggregates(db, new PricingEngine(table));
}
