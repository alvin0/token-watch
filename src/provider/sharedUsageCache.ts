/**
 * Usage responses shared between every VS Code window on the machine.
 *
 * Each window runs its own extension host, so a provider's in-memory cache
 * stops at the process boundary: three windows open meant three calls to an
 * endpoint that answers a burst with a run of 429s. The window that fetches
 * writes what it got — or the cooldown it was handed — here, and every other
 * window reads it before deciding to go to the network itself. The fetch runs
 * under a machine-wide lock, so windows that fall due together wait for the one
 * already fetching instead of each spending a request.
 *
 * Losing the file only costs the sharing: each window still has its own copy.
 *
 * This module MUST NOT import `vscode`.
 */

import { createHash } from "node:crypto";
import { readFileSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomicFile";
import { withCredentialRefreshLock, type RefreshLockOptions } from "./credentialRefreshLock";

export interface CachedUsage {
  value: unknown;
  cachedAt: number;
  expiresAt: number;
  /** When the request behind it started; an invalidation after that makes it stale. */
  requestedAt?: number;
}

/** One provider's in-memory usage state, keyed by request. */
export interface UsageCacheMaps {
  cache: Map<string, CachedUsage>;
  cooldowns: Map<string, number>;
  refusals: Map<string, number>;
}

export interface SharedUsageEntry {
  /** When this entry was written; a reader adopts each write once. */
  writtenAt: number;
  value?: unknown;
  cachedAt?: number;
  expiresAt?: number;
  requestedAt?: number;
  /** A refusal's cooldown, so a window that never saw the 429 still backs off. */
  retryAt?: number;
  refusals?: number;
  /** Responses to requests started before this describe an account that has since changed. */
  invalidatedAt?: number;
}

const VERSION = 1;
/** How often to look for a response another window shared; a stat, not a request. */
const SHARED_USAGE_POLL_MS = 2_000;
/** Keeps a slow fetch's lock from being reclaimed while its holder is alive. */
const FETCH_LOCK_HEARTBEAT_MS = 5_000;
/** Outlasts the slowest real fetch: two token refreshes and two requests. */
const FETCH_LOCK_WAIT_MS = 120_000;

/** `writtenAt` of the last entry this process wrote or adopted, per request key. */
const seen = new Map<string, number>();
/** Latest invalidation this process knows of, per request key. */
const invalidations = new Map<string, number>();

/** Path for a request key, named so the credential store is not leaked. */
export function sharedUsagePath(key: string, dir = tmpdir()): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(dir, `token-watch-usage-${digest}.json`);
}

export function readSharedUsage(path: string): SharedUsageEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; entry?: Partial<SharedUsageEntry> };
    const entry = parsed.entry;
    // Another version of the extension may still be running in an old window.
    if (parsed.version !== VERSION || !entry || typeof entry.writtenAt !== "number") {
      return undefined;
    }
    return {
      writtenAt: entry.writtenAt,
      ...("value" in entry && finite(entry.cachedAt) && finite(entry.expiresAt)
        ? { value: entry.value, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt }
        : {}),
      ...(finite(entry.requestedAt) ? { requestedAt: entry.requestedAt } : {}),
      ...(finite(entry.retryAt) ? { retryAt: entry.retryAt } : {}),
      ...(finite(entry.refusals) ? { refusals: entry.refusals } : {}),
      ...(finite(entry.invalidatedAt) ? { invalidatedAt: entry.invalidatedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeSharedUsage(path: string, entry: SharedUsageEntry): void {
  try {
    writeFileAtomicSync(path, JSON.stringify({ version: VERSION, entry }));
  } catch (error) {
    console.warn("[TokenWatch] Failed to share usage with other windows:", error);
  }
}

/**
 * Whether a cached response answers this request without going to the network.
 *
 * A forced refresh skips this window's own copy, but still takes a newer one
 * another window fetched: the Retry button is only enabled once the figures on
 * screen have gone stale, and a response fetched elsewhere since then is not.
 */
export function isUsable(cached: CachedUsage, now: number, force: boolean, knownCachedAt: number): boolean {
  return cached.expiresAt > now && (!force || cached.cachedAt > knownCachedAt);
}

/**
 * Take in whatever another window fetched, was refused, or invalidated since
 * this one last looked. Returns whether there was anything new.
 *
 * Only a newer response replaces the local one, but the cooldown and refusal
 * count follow the latest write: a success elsewhere ends the run of refusals
 * here too.
 */
export function adoptSharedUsage(maps: UsageCacheMaps, key: string, dir: string | undefined): boolean {
  const shared = readSharedUsage(sharedUsagePath(key, dir));
  if (!shared || shared.writtenAt <= (seen.get(key) ?? 0)) {
    return false;
  }
  seen.set(key, shared.writtenAt);

  const invalidatedAt = Math.max(invalidations.get(key) ?? 0, shared.invalidatedAt ?? 0);
  if (invalidatedAt > 0) {
    invalidations.set(key, invalidatedAt);
  }
  const local = maps.cache.get(key);
  if (local && startedAt(local) < invalidatedAt) {
    maps.cache.delete(key);
  }
  if (
    shared.cachedAt !== undefined
    && shared.expiresAt !== undefined
    && (shared.requestedAt ?? shared.cachedAt) >= invalidatedAt
    && shared.cachedAt > (maps.cache.get(key)?.cachedAt ?? Number.NEGATIVE_INFINITY)
  ) {
    maps.cache.set(key, {
      value: shared.value,
      cachedAt: shared.cachedAt,
      expiresAt: shared.expiresAt,
      ...(shared.requestedAt !== undefined ? { requestedAt: shared.requestedAt } : {}),
    });
  }
  if (shared.retryAt !== undefined && shared.retryAt > (maps.cooldowns.get(key) ?? 0)) {
    maps.cooldowns.set(key, shared.retryAt);
  }
  if (shared.refusals) {
    maps.refusals.set(key, shared.refusals);
  } else {
    maps.refusals.delete(key);
  }
  return true;
}

/**
 * The account changed upstream (a usage limit reset was spent): drop the cached
 * response here and in every other window, including one still in flight
 * elsewhere that would otherwise land afterwards and put the old figures back.
 */
export function invalidateSharedUsage(maps: UsageCacheMaps, key: string, dir: string | undefined, now: number): void {
  maps.cache.delete(key);
  invalidations.set(key, Math.max(invalidations.get(key) ?? 0, now));
  publishSharedUsage(maps, key, dir, now);
}

export interface FetchOncePerMachineOptions<T> {
  maps: UsageCacheMaps;
  key: string;
  dir: string | undefined;
  force: boolean;
  /** `cachedAt` of this window's own copy before it looked at the others. */
  knownCachedAt: number;
  now: () => number;
  lock: RefreshLockOptions | undefined;
  /** The provider's own fetch; it updates `maps` for success and refusal alike. */
  fetch: () => Promise<T>;
  rateLimited: (retryAt: number) => Error;
  isRateLimited: (error: unknown) => boolean;
}

/** Fetch at most once across every window for the same request. */
export async function fetchOncePerMachine<T>(options: FetchOncePerMachineOptions<T>): Promise<T> {
  const { maps, key, dir, force, knownCachedAt, now } = options;
  const outcome = await withCredentialRefreshLock(`usage:${key}`, async () => {
    // Another window may have fetched, or been refused, while this one waited.
    adoptSharedUsage(maps, key, dir);
    const current = now();
    const cached = maps.cache.get(key);
    if (cached && isUsable(cached, current, force, knownCachedAt)) {
      return cached.value as T;
    }
    const retryAt = maps.cooldowns.get(key) ?? 0;
    if (retryAt > current) {
      if (cached) {
        return cached.value as T;
      }
      throw options.rateLimited(retryAt);
    }
    return fetchAndPublish(options);
  }, { waitMs: FETCH_LOCK_WAIT_MS, heartbeatMs: FETCH_LOCK_HEARTBEAT_MS, ...options.lock });
  if (outcome.ran) {
    return outcome.value;
  }

  // The holder outlived the wait. Use what it left if it finished, otherwise
  // fetch unserialized, as before the lock existed.
  adoptSharedUsage(maps, key, dir);
  const cached = maps.cache.get(key);
  if (cached && cached.cachedAt > knownCachedAt) {
    return cached.value as T;
  }
  return fetchAndPublish(options);
}

/**
 * Call `onChange` when another window shares something for any of `keys`.
 *
 * By the time it is called the local cache already holds what was shared, so
 * a non-forced read answers from it without a request.
 *
 * Polls the file's stat rather than using `fs.watch`: every write replaces the
 * file by rename, which a watch on the file itself does not survive on every
 * platform. Returns the unsubscribe.
 */
export function watchSharedUsage(
  maps: UsageCacheMaps,
  keys: string[],
  dir: string | undefined,
  onChange: () => void,
  pollMs = SHARED_USAGE_POLL_MS,
): () => void {
  const stops = keys.map((key) => {
    const file = sharedUsagePath(key, dir);
    const listener = (current: Stats, previous: Stats) => {
      if (current.mtimeMs === previous.mtimeMs && current.ino === previous.ino) {
        return;
      }
      // This window's own writes were marked as seen when it made them.
      if (adoptSharedUsage(maps, key, dir)) {
        onChange();
      }
    };
    watchFile(file, { interval: pollMs, persistent: false }, listener);
    return () => unwatchFile(file, listener);
  });
  return () => { for (const stop of stops) { stop(); } };
}

async function fetchAndPublish<T>(options: FetchOncePerMachineOptions<T>): Promise<T> {
  const { maps, key, dir, now } = options;
  const requestedAt = now();
  try {
    const value = await options.fetch();
    const entry = maps.cache.get(key);
    // Only an entry this fetch wrote; a refusal hands back the older one untouched.
    if (entry && entry.cachedAt >= requestedAt) {
      entry.requestedAt = requestedAt;
    }
    publishSharedUsage(maps, key, dir, now());
    return value;
  } catch (error) {
    if (options.isRateLimited(error)) {
      publishSharedUsage(maps, key, dir, now());
    }
    throw error;
  }
}

function publishSharedUsage(maps: UsageCacheMaps, key: string, dir: string | undefined, now: number): void {
  const path = sharedUsagePath(key, dir);
  // Keep an invalidation another window wrote since this one last looked.
  const invalidatedAt = Math.max(invalidations.get(key) ?? 0, readSharedUsage(path)?.invalidatedAt ?? 0);
  if (invalidatedAt > 0) {
    invalidations.set(key, invalidatedAt);
  }
  let cached = maps.cache.get(key);
  if (cached && startedAt(cached) < invalidatedAt) {
    // Fetched before the account changed; sharing it would put the old figures back.
    maps.cache.delete(key);
    cached = undefined;
  }
  const retryAt = maps.cooldowns.get(key) ?? 0;
  const refusals = maps.refusals.get(key) ?? 0;
  seen.set(key, now);
  writeSharedUsage(path, {
    writtenAt: now,
    ...(cached ? { value: cached.value, cachedAt: cached.cachedAt, expiresAt: cached.expiresAt } : {}),
    ...(cached?.requestedAt !== undefined ? { requestedAt: cached.requestedAt } : {}),
    ...(retryAt > now ? { retryAt } : {}),
    ...(refusals > 0 ? { refusals } : {}),
    ...(invalidatedAt > 0 ? { invalidatedAt } : {}),
  });
}

function startedAt(entry: CachedUsage): number {
  return entry.requestedAt ?? entry.cachedAt;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
