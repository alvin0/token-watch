import type { UsageProvider } from "./protocol";

/**
 * How long a provider's usage response is worth reusing, per provider.
 *
 * The two services do not want the same cadence, and a single figure for both
 * was wrong in both directions at once.
 *
 * Codex: the official Codex TUI polls `backend-api/wham/usage` on a 60-second
 * interval (openai/codex#10869), and nothing reports that endpoint pushing
 * back. Matching the first-party client is the safest thing to match.
 *
 * Claude: `api/oauth/usage` rate-limits hard and sends no `Retry-After`
 * (anthropics/claude-code#31637). Polling at 30 to 60 seconds earns persistent
 * 429s; 180 seconds is the interval community tools settled on
 * (Maciek-roboblog/Claude-Code-Usage-Monitor#202).
 *
 * Each is a range rather than a number so several windows opened together do
 * not line up and hit the endpoint at the same instant.
 */
const BOUNDS: Record<UsageProvider, { minMs: number; maxMs: number }> = {
  codex: { minMs: 60_000, maxMs: 75_000 },
  claude: { minMs: 180_000, maxMs: 210_000 },
};

/**
 * The most conservative of the two, for callers with no provider in hand.
 *
 * Anything shared must not poll faster than the slower service tolerates.
 */
export const MIN_USAGE_RETRY_MS = BOUNDS.claude.minMs;
export const MAX_USAGE_RETRY_MS = BOUNDS.claude.maxMs;

export function usageRetryBounds(provider: UsageProvider): { minMs: number; maxMs: number } {
  return BOUNDS[provider];
}

/** How long to wait before asking this provider again. */
export function randomUsageRetryMs(provider: UsageProvider, random = Math.random): number {
  const { minMs, maxMs } = BOUNDS[provider];
  return Math.floor(minMs + random() * (maxMs - minMs + 1));
}

/**
 * How long to stand back after a provider says no.
 *
 * Claude's usage endpoint gives no `Retry-After`, so the wait has to be guessed
 * and then widened if it was guessed too short. Starting at the maximum, as
 * this used to, meant one transient refusal cost a quarter of an hour of stale
 * figures; climbing 3 → 6 → 12 → 15 minutes recovers quickly from a blip and
 * still backs right off from a real limit.
 */
const RATE_LIMIT_BACKOFF_MS = [3, 6, 12, 15].map((minutes) => minutes * 60_000);

export function rateLimitBackoffMs(consecutiveRefusals: number): number {
  const index = Math.min(Math.max(consecutiveRefusals, 1), RATE_LIMIT_BACKOFF_MS.length) - 1;
  return RATE_LIMIT_BACKOFF_MS[index];
}

/** The longest this will ever wait, for callers that need the ceiling. */
export const MAX_RATE_LIMIT_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
