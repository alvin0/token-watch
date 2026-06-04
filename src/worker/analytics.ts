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

export class AnalyticsService {
  constructor(private db: Database, private pricing: PricingEngine) {}

  query(q: AnalyticsQuery): AnalyticsResult {
    switch (q.view) {
      case "dashboard":
        return this.dashboard(q);
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
    // Use the range as-is from the query (store controls the range based on granularity)
    const series = queries.dailySeries(this.db, q);
    const variants = queries.variantBreakdown(this.db, q);
    const allSessions = queries.sessionLeaderboard(this.db, q);
    const sessions = allSessions.slice(0, 20);
    const tools = queries.toolUsage(this.db, q);

    return { view: "dashboard", series, variants, sessions, tools };
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
      if (row.unknownCostTurns > 0) entry.costUnknown = true;
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
