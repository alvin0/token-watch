/**
 * One refresh at a time, across every process on the machine.
 *
 * Anthropic (and OpenAI) hand out single-use refresh tokens that rotate with
 * no overlap window, so two processes refreshing the same credentials produce
 * one winner and one `invalid_grant` — and the loser, if it writes anything
 * back, can leave the store holding a grant the winner never saw. Claude Code
 * itself does not serialize this (anthropics/claude-code#54443, #56339), and
 * neither did we: every VS Code window runs its own extension host, so the
 * in-process promise map that deduplicates refreshes stops at the process
 * boundary.
 *
 * The lock is advisory and deliberately timid. A caller that cannot take it
 * does NOT queue up behind the holder to refresh next — that would spend a
 * second grant for nothing. It waits for the holder to finish and then reads
 * whatever the holder wrote.
 *
 * A holder that dies mid-refresh must not wedge every other window, so a lock
 * older than its TTL is reclaimed. The TTL therefore has to outlast a real
 * refresh (one bounded HTTP request) without stranding anyone for long.
 *
 * This module MUST NOT import `vscode`.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Long enough for a bounded refresh request, short enough not to strand a window. */
export const REFRESH_LOCK_TTL_MS = 20_000;
/** How long to wait for the holder before giving up and reading what it wrote. */
const DEFAULT_WAIT_MS = REFRESH_LOCK_TTL_MS;
const POLL_INTERVAL_MS = 100;

export interface RefreshLockOptions {
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Directory for the lock file; the system temp directory by default. */
  dir?: string;
}

export type RefreshLockOutcome<T> =
  | { ran: true; value: T }
  | { ran: false };

/**
 * Run `refresh` while holding the machine-wide lock for `key`.
 *
 * Returns `{ ran: false }` when another process holds it, which means that
 * process is refreshing the same credentials right now: read the store again
 * rather than refreshing as well.
 */
export async function withCredentialRefreshLock<T>(
  key: string,
  refresh: () => Promise<T>,
  options: RefreshLockOptions = {},
): Promise<RefreshLockOutcome<T>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? REFRESH_LOCK_TTL_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const lockPath = refreshLockPath(key, options.dir);

  const deadline = now() + waitMs;
  for (;;) {
    const fd = tryAcquire(lockPath, ttlMs, now);
    if (fd !== undefined) {
      try {
        return { ran: true, value: await refresh() };
      } finally {
        release(lockPath, fd);
      }
    }
    if (now() >= deadline) {
      return { ran: false };
    }
    await delay(pollMs);
  }
}

/** Lock path for a credential store, named so the store itself is not leaked. */
export function refreshLockPath(key: string, dir = tmpdir()): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(dir, `token-watch-refresh-${digest}.lock`);
}

function tryAcquire(lockPath: string, ttlMs: number, now: () => number): number | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // No lock directory, a read-only filesystem: refuse to serialize rather
        // than refuse to work. Racing is the pre-existing behaviour.
        return undefined;
      }
      if (attempt > 0) {
        return undefined;
      }
      let ageMs: number;
      try {
        ageMs = now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // It vanished between the open and the stat; try again.
      }
      if (ageMs <= ttlMs) {
        return undefined;
      }
      // The holder died mid-refresh; reclaim rather than deadlock every window.
      try { unlinkSync(lockPath); } catch { /* another process got there first */ }
    }
  }
  return undefined;
}

function release(lockPath: string, fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
  try { unlinkSync(lockPath); } catch { /* reclaimed as stale, or already gone */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
