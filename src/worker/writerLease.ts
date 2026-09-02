/**
 * Single-writer election for the shared global database.
 *
 * Every VS Code window runs its own ingestion worker, and all of them point at
 * the same file under `globalStorageUri`. A lease makes exactly one worker the
 * writer; the others become followers that reload the owner's snapshot instead
 * of fighting it for the file.
 *
 * Ownership is decided by the FILE, never by this object's memory:
 *
 *  - Every state transition (acquire, renew, take over, release) runs inside an
 *    exclusive lock file, so a renewal cannot land between another worker's
 *    read and its write and resurrect a lease that has already been handed on.
 *  - The lease record is replaced atomically (write a temp file, rename over),
 *    so a reader can never observe a half-written record.
 *  - `isOwner()` re-reads the file every time. Caching the answer — even for a
 *    second — meant a worker whose lease had just been stolen went on writing
 *    to the shared database believing it was still the writer.
 *
 * `isOwner()` is also the fence the store checks while holding its write lock
 * (see `UsageStore.setWriteFence`), so "only the lease holder may write" is
 * enforced at the moment of writing rather than merely assumed beforehand.
 *
 * This module MUST NOT import `vscode`.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

/** How long a lease stays valid without a renewal. */
export const LEASE_TTL_MS = 5 * 60 * 1000;
/** Renewals closer together than this are skipped; the TTL has ample margin. */
export const LEASE_RENEW_INTERVAL_MS = 60 * 1000;
/** A transition lock older than this is assumed abandoned. */
const LEASE_LOCK_STALE_MS = 30 * 1000;

interface LeaseRecord {
  pid: number;
  token: string;
  renewedAtMs: number;
}

export interface WriterLeaseOptions {
  leasePath: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  now?: () => number;
  pid?: number;
  /** Overridable for tests; defaults to a real liveness probe. */
  isProcessAlive?: (pid: number) => boolean;
}

export class WriterLease {
  private readonly token = randomUUID();
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private renewedAtMs = 0;

  constructor(private readonly options: WriterLeaseOptions) {
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.alive = options.isProcessAlive ?? isProcessAlive;
  }

  /**
   * Whether this worker may write, read from the lease file every time.
   *
   * Deliberately uncached: this is the fence the store consults inside its
   * write lock, and a cached answer there is the difference between "one
   * writer" and "one writer plus whoever used to be the writer".
   */
  isOwner(): boolean {
    const current = this.read();
    return current !== undefined
      && current.token === this.token
      && current.pid === this.pid
      && this.now() - current.renewedAtMs <= this.ttlMs;
  }

  /**
   * Acquire the lease, renew it if already held, or take it over when the
   * holder is gone. `steal` is for an explicit user action (a manual rescan) —
   * that window is asking to be the writer.
   *
   * Returns false when another worker is mid-transition; the caller simply is
   * not the writer for this tick and tries again on the next one.
   */
  tryAcquire({ steal = false, force = false }: { steal?: boolean; force?: boolean } = {}): boolean {
    return this.withLeaseLock(() => {
      const now = this.now();
      const current = this.read();

      if (current && current.token === this.token && current.pid === this.pid) {
        // Renewals are throttled: a per-file heartbeat that rewrote the file
        // every time was pure churn against a five-minute TTL.
        if (!force && now - this.renewedAtMs < this.renewIntervalMs) {
          return true;
        }
        return this.write(now);
      }

      const holderGone =
        !current ||
        now - current.renewedAtMs > this.ttlMs ||
        (current.pid !== this.pid && !this.alive(current.pid));

      if (!holderGone && !steal) {
        return false;
      }
      return this.write(now);
    }) ?? false;
  }

  /** Give up the lease so another window can take over immediately. */
  release(): void {
    this.withLeaseLock(() => {
      const current = this.read();
      if (current && current.token === this.token && current.pid === this.pid) {
        try { unlinkSync(this.options.leasePath); } catch { /* best-effort */ }
      }
      this.renewedAtMs = 0;
      return true;
    });
  }

  /** The token written into the lease file; the store's fencing identity. */
  fencingToken(): string {
    return this.token;
  }

  // --- Private ---

  /**
   * Run a lease transition with every other worker excluded.
   *
   * Acquire, renew and take-over all read the record and then replace it.
   * Without mutual exclusion a renewal could read "still mine", be overtaken by
   * a steal, and then write its stale record back over the new owner's.
   */
  private withLeaseLock<T>(transition: () => T): T | undefined {
    const lockPath = `${this.options.leasePath}.lock`;
    let fd: number | undefined;

    for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
      try {
        fd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") { return undefined; }
        let ageMs = 0;
        try {
          ageMs = this.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue; // It vanished; try to create it again.
        }
        if (attempt === 0 && ageMs > LEASE_LOCK_STALE_MS) {
          // The holder died mid-transition; reclaim rather than deadlock.
          try { unlinkSync(lockPath); } catch { /* another worker recovered it */ }
          continue;
        }
        return undefined;
      }
    }
    if (fd === undefined) { return undefined; }

    try {
      return transition();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* best-effort */ }
    }
  }

  /**
   * Replace the lease record atomically, so no reader sees a partial write and
   * no torn file can make the lease look unowned to everybody at once.
   */
  private write(now: number): boolean {
    const tempPath = `${this.options.leasePath}.${this.pid}.${this.token}.tmp`;
    try {
      writeFileSync(tempPath, this.serialize(now));
      renameSync(tempPath, this.options.leasePath);
      this.renewedAtMs = now;
      return true;
    } catch {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      return false;
    }
  }

  private serialize(now: number): string {
    return JSON.stringify({ pid: this.pid, token: this.token, renewedAtMs: now } satisfies LeaseRecord);
  }

  private read(): LeaseRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.options.leasePath, "utf8")) as Partial<LeaseRecord>;
      if (
        typeof parsed.pid !== "number" ||
        typeof parsed.token !== "string" ||
        typeof parsed.renewedAtMs !== "number"
      ) {
        return undefined;
      }
      return { pid: parsed.pid, token: parsed.token, renewedAtMs: parsed.renewedAtMs };
    } catch {
      return undefined;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
