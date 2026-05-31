import type { DailyAggregate } from "../../shared/storeTypes";
import { localDay as toLocalDayStr } from "../../shared/time";

export type Period = "day" | "week" | "month" | "year";
export type ChartMode = "Tokens" | "Cost" | "Turns";

export interface PAgg {
  tokens: number; cost: number; turns: number;
  input: number; output: number; cache: number; reasoning: number;
  models: number; activeDays: number;
}

export interface Bkt {
  key: string; label: string;
  tokens: number; cost: number; turns: number;
  input: number; output: number; cache: number; reasoning: number;
}

export function pRange(g: Period) {
  const now = new Date();
  const today = toLocalDayStr(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  if (g === "day") {
    const prevDay = toLocalDayStr(new Date(now.getTime() - 86400000));
    return { from: today, prevFrom: prevDay, prevTo: prevDay };
  }
  if (g === "week") {
    const from = toLocalDayStr(new Date(now.getTime() - 7 * 86400000));
    const prevFrom = toLocalDayStr(new Date(now.getTime() - 14 * 86400000));
    const prevTo = toLocalDayStr(new Date(now.getTime() - 8 * 86400000));
    return { from, prevFrom, prevTo };
  }
  if (g === "month") {
    // This calendar month
    const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    // Previous calendar month
    const prevMonth = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    const prevFrom = `${prevYear}-${String(prevMonth + 1).padStart(2, "0")}-01`;
    // Actually compute last day of prev month properly
    const lastDayPrev = toLocalDayStr(new Date(y, m, 0));
    return { from, prevFrom, prevTo: lastDayPrev };
  }
  // year: this calendar year
  const from = `${y}-01-01`;
  const prevFrom = `${y - 1}-01-01`;
  const prevTo = `${y - 1}-12-31`;
  return { from, prevFrom, prevTo };
}

export function computePeriods(series: DailyAggregate[], g: Period): { cur: PAgg; prev: PAgg; peakLabel: string } {
  const { from, prevFrom, prevTo } = pRange(g);
  const cur = agg(series, from, "9999");
  const prev = agg(series, prevFrom, prevTo);
  // Peak day
  const dayMap = new Map<string, number>();
  for (const r of series) { if (r.day >= from) { dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + r.totalTokens); } }
  let pk = ""; let pv = 0;
  for (const [d, v] of dayMap) { if (v > pv) { pv = v; pk = d; } }
  const peakLabel = pk ? new Date(pk + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
  return { cur, prev, peakLabel };
}

export function agg(series: DailyAggregate[], from: string, to: string): PAgg {
  let tokens = 0, cost = 0, turns = 0, input = 0, output = 0, cache = 0, reasoning = 0;
  const ms = new Set<string>();
  const days = new Set<string>();
  for (const r of series) {
    if (r.day >= from && r.day <= to) {
      tokens += r.totalTokens; cost += r.costUsd; turns += r.turns;
      input += r.inputTokens; output += r.outputTokens; cache += r.cacheReadTokens; reasoning += r.reasoningTokens;
      ms.add(r.variantId);
      days.add(r.day);
    }
  }
  return { tokens, cost, turns, input, output, cache, reasoning, models: ms.size, activeDays: days.size };
}

export function makeBuckets(series: DailyAggregate[], g: Period): Bkt[] {
  const map = new Map<string, Bkt>();
  for (const row of series) {
    const key = g === "day" ? row.day : g === "month" || g === "year" ? row.day.slice(0, 7) : wk(row.day);
    let label: string;
    if (g === "day") {
      label = new Date(row.day + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } else if (g === "week") {
      // Show range: "May 24 – 30"
      const weekStart = new Date(wk(row.day) + "T00:00:00");
      const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
      const startStr = weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const endStr = weekStart.getMonth() === weekEnd.getMonth()
        ? weekEnd.getDate().toString()
        : weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      label = `${startStr} – ${endStr}`;
    } else {
      // Month/Year: "May 2026"
      const d = new Date(row.day.slice(0, 7) + "-01T00:00:00");
      label = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    }
    let b = map.get(key);
    if (!b) { b = { key, label, tokens: 0, cost: 0, turns: 0, input: 0, output: 0, cache: 0, reasoning: 0 }; map.set(key, b); }
    b.tokens += row.totalTokens; b.cost += row.costUsd; b.turns += row.turns;
    b.input += row.inputTokens; b.output += row.outputTokens; b.cache += row.cacheReadTokens; b.reasoning += row.reasoningTokens;
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

export function wk(day: string): string {
  const d = new Date(day + "T00:00:00"); const dow = d.getDay() || 7;
  return toLocalDayStr(new Date(d.getTime() - (dow - 1) * 86400000));
}

export function fmtT(n: number): string {
  if (n >= 1e9) { return `${(n / 1e9).toFixed(1)}B`; }
  if (n >= 1e6) { return `${(n / 1e6).toFixed(1)}M`; }
  if (n >= 1e3) { return `${(n / 1e3).toFixed(1)}K`; }
  return Math.round(n).toLocaleString();
}
