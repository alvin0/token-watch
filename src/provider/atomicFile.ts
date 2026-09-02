/**
 * Atomic writes for credential files owned by other tools.
 *
 * Token Watch refreshes Codex and Claude OAuth tokens, which means it rewrites
 * files those CLIs also read and write. A plain `writeFile` truncates first: a
 * crash, a full disk, or the other tool reading mid-write leaves the user
 * signed out with no way back except re-authenticating. Every write here goes
 * to a temp file in the same directory, is fsynced, and is renamed into place —
 * a reader sees either the old file or the new one, never a half-written one.
 *
 * Two further guards:
 *  - File mode is preserved (credentials stay 0600 rather than reverting to the
 *    process umask).
 *  - The caller can pin the file identity it read, so a token rotated by the
 *    other tool in the meantime is not silently clobbered.
 *
 * This module MUST NOT import `vscode`.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Identity of a file at the moment it was read, for optimistic concurrency. */
export interface FileIdentity {
  size: number;
  mtimeMs: number;
  inode: number;
}

export class ConcurrentCredentialWriteError extends Error {
  constructor(public readonly path: string) {
    super(`${path} changed on disk since it was read; refusing to overwrite it`);
    this.name = "ConcurrentCredentialWriteError";
  }
}

export function isConcurrentCredentialWriteError(error: unknown): error is ConcurrentCredentialWriteError {
  return error instanceof ConcurrentCredentialWriteError;
}

export function fileIdentityOf(path: string): FileIdentity | undefined {
  try {
    return identityFromStats(statSync(path));
  } catch {
    return undefined;
  }
}

function identityFromStats(stats: Stats): FileIdentity {
  return { size: stats.size, mtimeMs: stats.mtimeMs, inode: Number(stats.ino) };
}

export interface AtomicWriteOptions {
  /** Mode for a file that does not exist yet. An existing file keeps its own. */
  mode?: number;
  /** Identity read before the update; a mismatch aborts the write. */
  expectedIdentity?: FileIdentity;
}

/**
 * Write `contents` to `path` atomically. Returns the identity of the new file.
 */
export function writeFileAtomicSync(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): FileIdentity {
  const current = fileIdentityOf(path);
  if (options.expectedIdentity && !sameIdentity(current, options.expectedIdentity)) {
    throw new ConcurrentCredentialWriteError(path);
  }

  const mode = existingMode(path) ?? options.mode ?? 0o600;
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  // Every failure path from here on removes the temp file: it holds the
  // plaintext credentials, and a half-written one left in the same directory
  // is a copy of the user's tokens nobody is tracking.
  try {
    const fd = openSync(tempPath, "wx", mode);
    try {
      writeFileSync(fd, contents, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // `open(..., mode)` is masked by umask; set the mode explicitly so a 0600
    // credentials file does not come back as 0644.
    chmodSync(tempPath, mode);

    // Re-check identity while the replacement is ready to go. This narrows the
    // window between the check and the rename; it cannot close it entirely —
    // POSIX rename is atomic but there is no compare-and-swap for it — so the
    // check is a guard against a slow concurrent refresh, not a lock.
    if (options.expectedIdentity && !sameIdentity(fileIdentityOf(path), options.expectedIdentity)) {
      throw new ConcurrentCredentialWriteError(path);
    }
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* already gone, or never created */ }
    throw error;
  }

  return fileIdentityOf(path) ?? { size: Buffer.byteLength(contents), mtimeMs: Date.now(), inode: 0 };
}

function sameIdentity(current: FileIdentity | undefined, expected: FileIdentity): boolean {
  if (!current) {
    // The file is gone. Writing it back is a create, which is fine only if the
    // caller did not read one either.
    return expected.size === 0 && expected.mtimeMs === 0 && expected.inode === 0;
  }
  // inode is 0 on filesystems that do not report one; fall back to size + mtime.
  if (current.inode !== 0 && expected.inode !== 0 && current.inode !== expected.inode) {
    return false;
  }
  return current.size === expected.size && current.mtimeMs === expected.mtimeMs;
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}
