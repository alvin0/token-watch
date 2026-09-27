/**
 * A usage response shared between every VS Code window on the machine.
 *
 * Each window runs its own extension host, so the provider's in-memory cache
 * stops at the process boundary: three windows open meant three calls to an
 * endpoint that answers a burst with a run of 429s. The window that fetches
 * writes what it got — or the cooldown it was handed — here, and every other
 * window reads it before deciding to go to the network itself.
 *
 * Losing this file only costs the sharing: each window still has its own copy.
 *
 * This module MUST NOT import `vscode`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomicFile";

export interface SharedUsageEntry {
  /** When this entry was written; a reader adopts each write once. */
  writtenAt: number;
  value?: unknown;
  cachedAt?: number;
  expiresAt?: number;
  /** A refusal's cooldown, so a window that never saw the 429 still backs off. */
  retryAt?: number;
  refusals?: number;
}

const VERSION = 1;

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
      ...(finite(entry.retryAt) ? { retryAt: entry.retryAt } : {}),
      ...(finite(entry.refusals) ? { refusals: entry.refusals } : {}),
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

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
