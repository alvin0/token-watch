import type { Source } from "../../shared/types.js";

/**
 * Bumped whenever a parser would read the same bytes differently.
 *
 * A file cursor records the revision that produced it, and a cursor written by
 * an older revision is re-read from the start rather than appended to. That is
 * the only way a correction reaches numbers already in the database: the logs
 * have not changed, so nothing else would prompt a re-read.
 *
 * Codex 2: the cumulative baseline used to be tracked against the session id.
 * Resuming a session replays its earlier turns under the old id and continues
 * under a new one from the same running total, so the first line after the
 * switch was charged for the entire history — 10,349,317,694 tokens too many,
 * 39% over, measured against one real set of logs. The same revision also
 * covers counting a restarted counter as a fresh series instead of discarding
 * it, and holding the reported total fixed when one component moves backwards.
 */
export const CODEX_PARSE_REVISION = 2;
export const CLAUDE_PARSE_REVISION = 1;

/**
 * The revision every parser was on when schema 6 databases were written.
 *
 * The v6 upgrade records a revision against each cursor it keeps, and that has
 * to be the revision the data was actually produced by. Stamping the current
 * one instead would assert those cursors had been read by today's parser, so a
 * later correction would never reach them — a v6 database would have kept the
 * inflated Codex counts for good.
 */
export const LEGACY_V6_PARSE_REVISION = 1;

export function parseRevisionForSource(source: Source): number {
  return source === "codex" ? CODEX_PARSE_REVISION : CLAUDE_PARSE_REVISION;
}
