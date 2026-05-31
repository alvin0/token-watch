/**
 * Shared local-day helpers.
 *
 * CRITICAL INVARIANT: the store writes `day_local` from a timestamp using the
 * machine's LOCAL calendar day, and every query that filters by `day_local`
 * MUST derive its day-string boundaries the same way. Mixing local-day writes
 * with UTC-day filters shifts "today/this week" by a day for users far from
 * UTC. Both sides go through these helpers so they can never diverge.
 *
 * This module MUST NOT import `vscode`.
 */

/** Format a `Date` as a local calendar day "YYYY-MM-DD". */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format an epoch-ms timestamp as a local calendar day "YYYY-MM-DD". */
export function localDayFromMs(utcMs: number): string {
  return localDay(new Date(utcMs));
}
