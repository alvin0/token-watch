/**
 * Consumers for the `tokenWatch.analytics.*` thresholds.
 *
 * Both settings shipped in the manifest for a long time with nothing reading
 * them: changing `anomalyMultiplier` or `contextFillWarnPct` did nothing at
 * all. These are the pure functions the UI applies to the data it already has.
 *
 * This module MUST NOT import `vscode`.
 */

import type { DailyAggregate, SessionAggregate } from "./storeTypes";
import { localDay, parseLocalDay, shiftLocalDay } from "./time";

/** Trailing days compared against when deciding whether a day is unusual. */
export const ANOMALY_WINDOW_DAYS = 14;
/** Below this many observed days a median is noise, so nothing is flagged. */
export const ANOMALY_MIN_SAMPLES = 5;

export interface CostAnomaly {
  day: string;
  costUsd: number;
  /**
   * The baseline this day was judged against: the median of the trailing
   * calendar window, or its mean when more than half that window was idle and
   * the median is therefore zero.
   */
  medianUsd: number;
  /** costUsd / medianUsd. */
  ratio: number;
}

/**
 * Days whose cost exceeds `multiplier` × the median of the preceding window.
 *
 * The window is `windowDays` CALENDAR days, not the last N days that happen to
 * carry rows. Idle days cost nothing and belong in the median — skipping them
 * measured a spike against the last fortnight of *activity*, which on an
 * occasional-use machine could stretch back months and hide the spike entirely.
 *
 * The median is taken over the days BEFORE the candidate, so a single expensive
 * day cannot raise the bar it is being judged against.
 */
export function detectCostAnomalies(
  series: DailyAggregate[],
  multiplier: number,
  windowDays = ANOMALY_WINDOW_DAYS,
): CostAnomaly[] {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return [];
  }

  const byDay = new Map<string, number>();
  for (const row of series) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.costUsd);
  }
  if (byDay.size === 0) {
    return [];
  }

  const observed = [...byDay.keys()].sort();
  const firstDay = observed[0];
  const lastDay = observed[observed.length - 1];

  const anomalies: CostAnomaly[] = [];
  for (let day = firstDay; day <= lastDay; day = shiftLocalDay(day, 1)) {
    const costUsd = byDay.get(day) ?? 0;
    if (costUsd <= 0) {
      // A quiet day is part of every window that follows it, but it is never
      // itself an anomaly.
      continue;
    }

    const window: number[] = [];
    for (let offset = windowDays; offset >= 1; offset--) {
      const previous = shiftLocalDay(day, -offset);
      if (previous < firstDay) { continue; }
      window.push(byDay.get(previous) ?? 0);
    }
    if (window.length < ANOMALY_MIN_SAMPLES) {
      continue;
    }

    // On an intermittently used machine more than half a fortnight can be
    // idle, which makes the median exactly zero. Falling back to the mean keeps
    // the check working there instead of silently disabling it; a window that
    // is entirely idle has no baseline at all, so nothing is claimed.
    const middle = median(window);
    const medianUsd = middle > 0 ? middle : mean(window);
    if (medianUsd <= 0) {
      continue;
    }
    const ratio = costUsd / medianUsd;
    if (ratio > multiplier) {
      anomalies.push({ day, costUsd, medianUsd, ratio });
    }
  }
  return anomalies;
}

/** Exposed for tests: the calendar day a timestamp falls on, locally. */
export function anomalyDayOf(timestamp: number): string {
  return localDay(new Date(timestamp));
}

/** Exposed for tests: parse a day string the detector produced. */
export function parseAnomalyDay(day: string): Date {
  return parseLocalDay(day);
}

export interface HighContextSession {
  source: SessionAggregate["source"];
  sessionId: string;
  workspace: string;
  /** Peak context fill as a percentage, 0–100. */
  peakFillPct: number;
  totalTokens: number;
}

/**
 * Sessions whose peak context fill reached the configured warning threshold.
 *
 * `peakContextFill` is a 0–1 ratio in the store; the setting is a percentage.
 */
export function highContextSessions(
  sessions: SessionAggregate[],
  warnPct: number,
): HighContextSession[] {
  if (!Number.isFinite(warnPct) || warnPct <= 0) {
    return [];
  }
  return sessions
    .filter((session) => typeof session.peakContextFill === "number")
    .map((session) => ({
      source: session.source,
      sessionId: session.sessionId,
      workspace: session.workspace,
      peakFillPct: (session.peakContextFill ?? 0) * 100,
      totalTokens: session.totalTokens,
    }))
    .filter((session) => session.peakFillPct >= warnPct)
    .sort((left, right) => right.peakFillPct - left.peakFillPct);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
