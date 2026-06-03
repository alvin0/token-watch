import type { DailyAggregate } from "../../shared/storeTypes";
import { localDay as toLocalDayStr } from "../../shared/time";

export type Period = "today" | "day" | "week" | "month" | "year";
export type ChartMode = "Tokens" | "Cost" | "Turns";
const DAY_MS = 24 * 60 * 60 * 1000;

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

export interface PeriodRange {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  bucketCount: number;
}

export function pRange(g: Period, now = new Date()): PeriodRange {
  const today = toLocalDayStr(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  if (g === "today") {
    const prevDay = toLocalDayStr(new Date(now.getTime() - DAY_MS));
    return { from: today, to: today, prevFrom: prevDay, prevTo: prevDay, bucketCount: 1 };
  }
  if (g === "day") {
    const from = toLocalDayStr(new Date(now.getTime() - 6 * DAY_MS));
    const prevFrom = toLocalDayStr(new Date(now.getTime() - 13 * DAY_MS));
    const prevTo = toLocalDayStr(new Date(now.getTime() - 7 * DAY_MS));
    return { from, to: today, prevFrom, prevTo, bucketCount: 7 };
  }
  if (g === "week") {
    const currentWeekStart = weekStart(today);
    const from = toLocalDayStr(new Date(currentWeekStart.getTime() - 6 * 7 * DAY_MS));
    const prevFrom = toLocalDayStr(new Date(currentWeekStart.getTime() - 13 * 7 * DAY_MS));
    const prevTo = toLocalDayStr(new Date(new Date(from + "T00:00:00").getTime() - DAY_MS));
    return { from, to: today, prevFrom, prevTo, bucketCount: 7 };
  }
  if (g === "month") {
    const from = monthStart(addMonths(new Date(y, m, 1), -5));
    const prevFrom = monthStart(addMonths(new Date(y, m, 1), -11));
    const prevTo = toLocalDayStr(new Date(new Date(from + "T00:00:00").getTime() - DAY_MS));
    return { from, to: today, prevFrom, prevTo, bucketCount: 6 };
  }
  const from = `${y - 1}-01-01`;
  const prevFrom = `${y - 3}-01-01`;
  const prevTo = `${y - 2}-12-31`;
  return { from, to: today, prevFrom, prevTo, bucketCount: 2 };
}

export function queryRangeForPeriod(g: Period): { fromUtc: number; toUtc: number } {
  const range = pRange(g);
  return {
    fromUtc: new Date(`${range.prevFrom}T00:00:00`).getTime(),
    toUtc: Date.now(),
  };
}

export function computePeriods(series: DailyAggregate[], g: Period): { cur: PAgg; prev: PAgg; peakLabel: string } {
  const { from, to, prevFrom, prevTo } = pRange(g);
  const cur = agg(series, from, to);
  const prev = agg(series, prevFrom, prevTo);
  // Peak day
  const dayMap = new Map<string, number>();
  for (const r of series) {
    if (r.day >= from && r.day <= to) {
      dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + r.totalTokens);
    }
  }
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
  const { from, to } = pRange(g);
  const map = new Map<string, Bkt>();
  for (const bucket of periodBuckets(g)) {
    map.set(bucket.key, bucket);
  }

  for (const row of series) {
    if (row.day < from || row.day > to) {
      continue;
    }
    const key = bucketKey(row.day, g);
    const b = map.get(key);
    if (!b) {
      continue;
    }
    b.tokens += row.totalTokens; b.cost += row.costUsd; b.turns += row.turns;
    b.input += row.inputTokens; b.output += row.outputTokens; b.cache += row.cacheReadTokens; b.reasoning += row.reasoningTokens;
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

export function wk(day: string): string {
  return toLocalDayStr(weekStart(day));
}

function periodBuckets(g: Period): Bkt[] {
  const now = new Date();
  const buckets: Bkt[] = [];

  if (g === "day") {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() - i * DAY_MS);
      const key = toLocalDayStr(d);
      buckets.push(emptyBucket(key, d.toLocaleDateString("en-US", { month: "short", day: "numeric" })));
    }
    return buckets;
  }

  if (g === "today") {
    const key = toLocalDayStr(now);
    return [emptyBucket(key, "Today")];
  }

  if (g === "week") {
    const start = weekStart(toLocalDayStr(now));
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() - i * 7 * DAY_MS);
      buckets.push(emptyBucket(toLocalDayStr(d), weekLabel(d)));
    }
    return buckets;
  }

  if (g === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < 6; i++) {
      const d = addMonths(start, -i);
      const key = monthStart(d).slice(0, 7);
      buckets.push(emptyBucket(key, d.toLocaleDateString("en-US", { month: "short", year: "numeric" })));
    }
    return buckets;
  }

  for (let i = 0; i < 2; i++) {
    const year = String(now.getFullYear() - i);
    buckets.push(emptyBucket(year, year));
  }
  return buckets;
}

function emptyBucket(key: string, label: string): Bkt {
  return { key, label, tokens: 0, cost: 0, turns: 0, input: 0, output: 0, cache: 0, reasoning: 0 };
}

function bucketKey(day: string, g: Period): string {
  if (g === "today" || g === "day") { return day; }
  if (g === "week") { return wk(day); }
  if (g === "month") { return day.slice(0, 7); }
  return day.slice(0, 4);
}

function weekStart(day: string): Date {
  const d = new Date(day + "T00:00:00");
  const dow = d.getDay() || 7;
  return new Date(d.getTime() - (dow - 1) * DAY_MS);
}

function weekLabel(weekStartDate: Date): string {
  const weekEnd = new Date(weekStartDate.getTime() + 6 * DAY_MS);
  const startStr = weekStartDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = weekStartDate.getMonth() === weekEnd.getMonth()
    ? weekEnd.getDate().toString()
    : weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${startStr} – ${endStr}`;
}

function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function addMonths(d: Date, amount: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + amount, 1);
}

export function fmtT(n: number): string {
  if (n >= 1e9) { return `${(n / 1e9).toFixed(1)}B`; }
  if (n >= 1e6) { return `${(n / 1e6).toFixed(1)}M`; }
  if (n >= 1e3) { return `${(n / 1e3).toFixed(1)}K`; }
  return Math.round(n).toLocaleString();
}
