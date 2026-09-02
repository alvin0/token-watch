/**
 * Per-file failure isolation for ingestion.
 *
 * A file that disappears mid-scan, or that the OS refuses to read, used to
 * abort the whole scan — every candidate ranked behind it was silently never
 * ingested. Failures are now contained to the file: it is quarantined with an
 * exponential backoff and the scan continues.
 *
 * State is in-memory and per worker session. A quarantine is not a permanent
 * verdict: the entry expires, and a manual rescan clears the register.
 *
 * This module MUST NOT import `vscode`.
 */

/** Backoff ladder; the last value repeats for further failures. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export interface QuarantineEntry {
  filePath: string;
  failures: number;
  /** Epoch ms before which the file is skipped. */
  retryAtMs: number;
  lastError: string;
}

export class FileQuarantine {
  private readonly entries = new Map<string, QuarantineEntry>();

  /** True while the file is still inside its backoff window. */
  shouldSkip(filePath: string, now = Date.now()): boolean {
    const entry = this.entries.get(filePath);
    return entry !== undefined && entry.retryAtMs > now;
  }

  recordFailure(filePath: string, error: unknown, now = Date.now()): QuarantineEntry {
    const previous = this.entries.get(filePath);
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    const entry: QuarantineEntry = {
      filePath,
      failures,
      retryAtMs: now + backoff,
      lastError: describe(error),
    };
    this.entries.set(filePath, entry);
    return entry;
  }

  /** A successful pass clears the file's history. */
  recordSuccess(filePath: string): void {
    this.entries.delete(filePath);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Snapshot for diagnostics, most-failed first. */
  snapshot(): QuarantineEntry[] {
    return [...this.entries.values()].sort(
      (left, right) => right.failures - left.failures || left.filePath.localeCompare(right.filePath),
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message;
    return code ? `${code}: ${message}` : message;
  }
  return "Unknown error";
}
