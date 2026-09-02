import type { DailyAggregate } from "../../shared/storeTypes";
import {
  addLocalDays,
  localDay as toLocalDayStr,
  parseLocalDay,
  shiftLocalDay,
} from "../../shared/time";
import { deriveTokenMetrics, type TokenMetrics } from "../../shared/tokenMetrics";

export type Period = "today" | "day" | "week" | "month" | "year";
export type ChartMode = "Tokens" | "Cost" | "Turns";

/** Fallback locale for date labels when the caller has no UI locale to pass. */
const DEFAULT_LOCALE = "en-US";

export interface PAgg {
  tokens: number; cost: number; turns: number;
  input: number; output: number; cache: number; cacheWrite: number; reasoning: number;
  models: number; activeDays: number;
  /** Derived, invariant-checked view of the same numbers. */
  metrics: TokenMetrics;
}

export interface Bkt {
  key: string; label: string;
  tokens: number; cost: number; turns: number;
  input: number; output: number; cache: number; cacheWrite: number; reasoning: number;
}

export interface PeriodRange {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  bucketCount: number;
}

export function currentRangeForPeriod(g: Period, now = new Date()): { from: string; to: string } {
  const today = toLocalDayStr(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  if (g === "week") {
    return { from: weekStartDay(today), to: today };
  }
  if (g === "month") {
    return { from: monthStart(new Date(y, m, 1)), to: today };
  }
  if (g === "year") {
    return { from: `${y}-01-01`, to: today };
  }
  return { from: today, to: today };
}

export function pRange(g: Period, now = new Date()): PeriodRange {
  const today = toLocalDayStr(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  if (g === "today") {
    const prevDay = shiftLocalDay(today, -1);
    return { from: today, to: today, prevFrom: prevDay, prevTo: prevDay, bucketCount: 1 };
  }
  if (g === "day") {
    return {
      from: shiftLocalDay(today, -6),
      to: today,
      prevFrom: shiftLocalDay(today, -13),
      prevTo: shiftLocalDay(today, -7),
      bucketCount: 7,
    };
  }
  if (g === "week") {
    const currentWeekStart = weekStartDay(today);
    const from = shiftLocalDay(currentWeekStart, -6 * 7);
    return {
      from,
      to: today,
      prevFrom: shiftLocalDay(currentWeekStart, -13 * 7),
      prevTo: shiftLocalDay(from, -1),
      bucketCount: 7,
    };
  }
  if (g === "month") {
    const from = monthStart(addMonths(new Date(y, m, 1), -5));
    return {
      from,
      to: today,
      prevFrom: monthStart(addMonths(new Date(y, m, 1), -11)),
      prevTo: shiftLocalDay(from, -1),
      bucketCount: 6,
    };
  }
  return {
    from: `${y - 1}-01-01`,
    to: today,
    prevFrom: `${y - 3}-01-01`,
    prevTo: `${y - 2}-12-31`,
    bucketCount: 2,
  };
}

/**
 * Trailing days every dashboard query includes beyond its visible window.
 *
 * Cards filter to the visible range themselves, so the extra rows cost only
 * transfer size — but without them the "Today" tab fetched two days, and any
 * comparison that needs a trailing baseline (the cost-anomaly detector needs a
 * median over {@link ANOMALY_WINDOW_DAYS}) had nothing to compare against.
 */
export const BASELINE_HISTORY_DAYS = 21;

/**
 * Everything the worker must read for a period: the visible window, the window
 * it is compared against, and the trailing baseline.
 */
export function queryRangeForPeriod(g: Period): { fromUtc: number; toUtc: number } {
  const range = pRange(g);
  const windowStart = parseLocalDay(range.prevFrom);
  const baselineStart = parseLocalDay(shiftLocalDay(range.from, -BASELINE_HISTORY_DAYS));
  return {
    fromUtc: Math.min(windowStart.getTime(), baselineStart.getTime()),
    toUtc: Date.now(),
  };
}

/**
 * Just the window on screen.
 *
 * Results the UI renders whole — the tool table, the session lists — are
 * scoped to this, so trailing baseline history never shows up as if it were
 * part of the selected period.
 */
export function visibleRangeForPeriod(g: Period, now = new Date()): { fromUtc: number; toUtc: number } {
  const { from } = pRange(g, now);
  return { fromUtc: parseLocalDay(from).getTime(), toUtc: now.getTime() };
}

export function computePeriods(
  series: DailyAggregate[],
  g: Period,
  locale: string = DEFAULT_LOCALE,
): { cur: PAgg; prev: PAgg; peakLabel: string } {
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
  const peakLabel = pk
    ? parseLocalDay(pk).toLocaleDateString(locale, { month: "short", day: "numeric" })
    : "—";
  return { cur, prev, peakLabel };
}

export function agg(series: DailyAggregate[], from: string, to: string): PAgg {
  let tokens = 0, cost = 0, turns = 0, input = 0, output = 0, cache = 0, cacheWrite = 0, reasoning = 0;
  const ms = new Set<string>();
  const days = new Set<string>();
  for (const r of series) {
    if (r.day >= from && r.day <= to) {
      tokens += r.totalTokens; cost += r.costUsd; turns += r.turns;
      input += r.inputTokens; output += r.outputTokens; cache += r.cacheReadTokens;
      cacheWrite += r.cacheCreationTokens; reasoning += r.reasoningTokens;
      // Codex and Claude can share a model id; keep them apart when counting.
      ms.add(`${r.source}:${r.variantId}`);
      days.add(r.day);
    }
  }
  const metrics = deriveTokenMetrics({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cache,
    cacheCreationTokens: cacheWrite,
    reasoningTokens: reasoning,
    totalTokens: tokens,
  });
  return { tokens, cost, turns, input, output, cache, cacheWrite, reasoning, models: ms.size, activeDays: days.size, metrics };
}

export function makeBuckets(
  series: DailyAggregate[],
  g: Period,
  now = new Date(),
  locale: string = DEFAULT_LOCALE,
): Bkt[] {
  const { from, to } = pRange(g, now);
  const map = new Map<string, Bkt>();
  for (const bucket of periodBuckets(g, now, locale)) {
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
    b.input += row.inputTokens; b.output += row.outputTokens; b.cache += row.cacheReadTokens;
    b.cacheWrite += row.cacheCreationTokens; b.reasoning += row.reasoningTokens;
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

export function previousPeriodAnchor(g: Period, now = new Date()): Date {
  if (g === "day") { return addLocalDays(now, -7); }
  if (g === "week") { return addLocalDays(now, -7 * 7); }
  // Clamp the day-of-month. On the 31st, `new Date(y, m - 6, 31)` rolls into
  // the following month when the target is shorter, shifting the whole
  // comparison window by one bucket (31 Mar 2026 produced May-Oct, not Apr-Sep).
  if (g === "month") { return shiftMonths(now, -6); }
  if (g === "year") { return shiftMonths(now, -24); }
  return addLocalDays(now, -1);
}

/** Shift by whole months, clamping the day to the target month's length. */
function shiftMonths(from: Date, months: number): Date {
  const year = from.getFullYear();
  const month = from.getMonth() + months;
  const lastDayOfTarget = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(from.getDate(), lastDayOfTarget));
}

export function wk(day: string): string {
  return weekStartDay(day);
}

function periodBuckets(g: Period, now = new Date(), locale: string = DEFAULT_LOCALE): Bkt[] {
  const buckets: Bkt[] = [];

  if (g === "day") {
    const today = toLocalDayStr(now);
    for (let i = 0; i < 7; i++) {
      const key = shiftLocalDay(today, -i);
      buckets.push(emptyBucket(
        key,
        parseLocalDay(key).toLocaleDateString(locale, { month: "short", day: "numeric" }),
      ));
    }
    return buckets;
  }

  if (g === "today") {
    const key = toLocalDayStr(now);
    return [emptyBucket(key, "Today")];
  }

  if (g === "week") {
    const start = weekStartDay(toLocalDayStr(now));
    for (let i = 0; i < 7; i++) {
      const key = shiftLocalDay(start, -i * 7);
      buckets.push(emptyBucket(key, weekLabel(key, locale)));
    }
    return buckets;
  }

  if (g === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < 6; i++) {
      const d = addMonths(start, -i);
      const key = monthStart(d).slice(0, 7);
      buckets.push(emptyBucket(key, d.toLocaleDateString(locale, { month: "short", year: "numeric" })));
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
  return { key, label, tokens: 0, cost: 0, turns: 0, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0 };
}

function bucketKey(day: string, g: Period): string {
  if (g === "today" || g === "day") { return day; }
  if (g === "week") { return wk(day); }
  if (g === "month") { return day.slice(0, 7); }
  return day.slice(0, 4);
}

/** Monday-anchored week start for a local calendar day, DST-safe. */
function weekStartDay(day: string): string {
  const d = parseLocalDay(day);
  const dow = d.getDay() || 7;
  return shiftLocalDay(day, -(dow - 1));
}

function weekLabel(weekStartDayStr: string, locale: string): string {
  const start = parseLocalDay(weekStartDayStr);
  const end = parseLocalDay(shiftLocalDay(weekStartDayStr, 6));
  const startStr = start.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const endStr = start.getMonth() === end.getMonth()
    ? end.getDate().toString()
    : end.toLocaleDateString(locale, { month: "short", day: "numeric" });
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
