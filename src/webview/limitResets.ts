import type { UsageLimitResetsInfo } from "../shared/protocol";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The deadline among the available resets: the first one to run out.
 *
 * The card shows a count and one date. The order the provider sends resets in
 * is not the order they expire, so the date has to be chosen rather than taken
 * from the front of the list — and a reset with no expiry is not a deadline of
 * zero, it is simply not one.
 *
 * Lives here rather than beside the component so it can be tested without
 * pulling React into the suite.
 */
export function soonestExpiry(limitResets: UsageLimitResetsInfo | undefined): number | undefined {
  let soonest: number | undefined;
  for (const reset of limitResets?.resets ?? []) {
    if (!isFiniteNumber(reset.expiresAtUtc)) { continue; }
    if (soonest === undefined || reset.expiresAtUtc < soonest) { soonest = reset.expiresAtUtc; }
  }
  return soonest;
}

/** Day then time, composed separately so every locale reads date-first. */
export function formatLimitResetExpiry(expiresAtUtc: number, locale: string): string {
  const expiry = new Date(expiresAtUtc);
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(expiry);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(expiry);
  return `${day}, ${time}`;
}
