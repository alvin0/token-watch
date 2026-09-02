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

/**
 * Identity of the timezone the local-day columns are materialized in.
 *
 * `day_local` and `hour_local` are computed once at ingest from the machine's
 * clock. Moving timezone — or opening the same global database over Remote SSH
 * or WSL — changes what "today" means without changing a single stored row, so
 * the identity is recorded alongside the data and checked on open.
 *
 * The UTC offset is part of it because a fixed-offset environment can report no
 * IANA zone at all.
 */
export function localTimezoneIdentity(now = new Date()): string {
  let zone = "unknown";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    // Some minimal ICU builds have no zone; the offset alone still detects a move.
  }
  return `${zone}@${-now.getTimezoneOffset()}`;
}

/** Whether two identities differ in a way that shifts calendar-day boundaries. */
export function timezoneIdentityChanged(stored: string | undefined, current: string): boolean {
  if (!stored || stored === current) { return false; }

  const [storedZone, storedOffset] = splitIdentity(stored);
  const [currentZone, currentOffset] = splitIdentity(current);

  if (storedZone === "unknown" || currentZone === "unknown") {
    // No usable zone name on at least one side — a minimal-ICU or fixed-offset
    // environment. The offset is then the only evidence of a move, so use it;
    // a false positive costs a re-read, a false negative misdates every day.
    return storedOffset !== currentOffset;
  }
  // A DST transition changes the offset without moving the machine; only the
  // zone name matters for whether stored days were computed differently.
  return storedZone !== currentZone;
}

function splitIdentity(identity: string): [zone: string, offset: string] {
  const at = identity.lastIndexOf("@");
  return at < 0 ? [identity, ""] : [identity.slice(0, at), identity.slice(at + 1)];
}

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

/**
 * Parse a local calendar day "YYYY-MM-DD" into a `Date` at local midnight.
 * Returns an invalid-free value only for well-formed input; callers pass day
 * strings produced by `localDay`.
 */
export function parseLocalDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, date ?? 1);
}

/**
 * Shift a `Date` by whole calendar days in LOCAL time.
 *
 * DST-safe: adding N days to a wall-clock date is calendar arithmetic, not
 * `N * 24h`. Across a DST boundary the fixed-millisecond form lands an hour
 * short or long and silently reports the neighbouring calendar day.
 */
export function addLocalDays(d: Date, amount: number): Date {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + amount,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
}

/** Shift a local calendar day string by whole days, DST-safe. */
export function shiftLocalDay(day: string, amount: number): string {
  return localDay(addLocalDays(parseLocalDay(day), amount));
}
