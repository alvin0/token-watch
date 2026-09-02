/**
 * Analytics service — translates an AnalyticsQuery into store query calls and
 * derives computed metrics. Dispatches on `query.view` and delegates heavy SQL
 * to the query functions in `./store/queries.ts`.
 *
 * This module MUST NOT import `vscode`.
 */

import type { Database } from "sql.js";
import type {
  AnalyticsQuery,
  AnalyticsResult,
  FreshnessInfo,
  WarningInfo,
  RateLimitInfo,
  SourceComparison,
} from "../shared/protocol.js";
import type { DailyAggregate } from "../shared/storeTypes.js";
import type { Source } from "../shared/types.js";
import * as queries from "./store/queries.js";
import { PricingEngine } from "./pricing.js";

const HOURLY_SERIES_MAX_RANGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Sessions the dashboard renders; the rest are never looked at. */
const DASHBOARD_SESSION_LIMIT = 20;

export class AnalyticsService {
  constructor(private db: Database, private pricing: PricingEngine) {}

  query(q: AnalyticsQuery): AnalyticsResult {
    switch (q.view) {
      case "dashboard":
        return this.dashboard(q);
      case "hourly":
        return { view: "hourly", hourlySeries: queries.hourlySeries(this.db, q, this.pricing) };
      case "series":
        return { view: "series", series: queries.dailySeries(this.db, q) };
      case "variants":
        return { view: "variants", variants: queries.variantBreakdown(this.db, q) };
      case "sessions":
        return { view: "sessions", sessions: queries.sessionLeaderboard(this.db, q) };
      case "tools":
        return { view: "tools", tools: queries.toolUsage(this.db, q) };
      case "heatmap":
        return { view: "heatmap", heatmap: queries.heatmap(this.db, q) };
      case "comparison":
        return { view: "comparison", comparison: this.comparison(q) };
    }
  }

  freshness(): FreshnessInfo {
    return queries.freshness(this.db);
  }

  warnings(): WarningInfo {
    return queries.warnings(this.db);
  }

  latestRateLimit(): RateLimitInfo | undefined {
    return queries.latestRateLimit(this.db);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private dashboard(q: AnalyticsQuery): AnalyticsResult {
    // `range` is everything to read: visible period + comparison + baseline.
    // The daily series needs all of it, because the comparison and the anomaly
    // baseline are computed from it and the cards filter by day themselves.
    const series = queries.dailySeries(this.db, q);

    // These are rendered whole, so they are scoped to what the reader can see.
    // Sharing `range` with the series meant the Today tab listed tool calls and
    // flagged context-heavy sessions from weeks of trailing baseline history.
    const visible = q.visibleRange ? { ...q, range: q.visibleRange } : q;
    const variants = queries.variantBreakdown(this.db, visible);
    // Limited in SQL: loading every session in order to show twenty grew with
    // total history rather than with what is on screen.
    const sessions = queries.sessionLeaderboard(this.db, visible, undefined, DASHBOARD_SESSION_LIMIT);
    // Ordered by peak fill, not cost: the cost leaderboard is truncated, and a
    // near-full context window is worth flagging however little it cost.
    const contextSessions = queries.sessionsByContextFill(this.db, visible);
    const tools = queries.toolUsage(this.db, visible);
    const toolCallsByDay = queries.toolCallsByDay(this.db, visible);
    // Bounded by the sub-range the caller will actually draw, falling back to
    // the full range for callers that do not ask for one.
    const hourlyQuery = q.hourlyRange ? { ...q, range: q.hourlyRange } : q;
    const hourlySeries = hourlyQuery.range.toUtc - hourlyQuery.range.fromUtc <= HOURLY_SERIES_MAX_RANGE_MS
      ? queries.hourlySeries(this.db, hourlyQuery, this.pricing)
      : [];

    return { view: "dashboard", series, variants, sessions, contextSessions, tools, toolCallsByDay, hourlySeries };
  }

  /**
   * Codex-vs-Claude comparison: aggregate dailySeries by source (Req 11.12).
   */
  private comparison(q: AnalyticsQuery): SourceComparison[] {
    const series = queries.dailySeries(this.db, q);
    return this.aggregateBySource(series);
  }

  private aggregateBySource(series: DailyAggregate[]): SourceComparison[] {
    const map = new Map<Source, { totalTokens: number; costUsd: number; costUnknown: boolean; turns: number; sessions: Set<string> }>();

    for (const row of series) {
      let entry = map.get(row.source);
      if (!entry) {
        entry = { totalTokens: 0, costUsd: 0, costUnknown: false, turns: 0, sessions: new Set() };
        map.set(row.source, entry);
      }
      entry.totalTokens += row.totalTokens;
      entry.costUsd += row.costUsd;
      if (row.unknownCostTurns > 0) {
        entry.costUnknown = true;
      }
      entry.turns += row.turns;
      // dailySeries doesn't carry sessionId; use day+workspace as proxy for session count
      entry.sessions.add(`${row.day}:${row.workspace}`);
    }

    const result: SourceComparison[] = [];
    for (const [source, entry] of map) {
      result.push({
        source,
        totalTokens: entry.totalTokens,
        costUsd: entry.costUsd,
        costUnknown: entry.costUnknown,
        turns: entry.turns,
        sessions: entry.sessions.size,
      });
    }

    return result;
  }
}
