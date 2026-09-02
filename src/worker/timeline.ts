/**
 * What the worker actually spent its time on, on the machine it ran on.
 *
 * Benchmarks here have repeatedly been optimistic: they call the code directly,
 * on a developer's disk, with nothing else competing. The wait a user sees is
 * made of things a benchmark does not reproduce — a message that arrives while
 * the thread is busy, a scan over more logs than the test fixture, a slower
 * disk. This records the real thing and reports it, so the next slow start is
 * something to read rather than something to guess at.
 *
 * Deliberately cheap: a bounded ring of numbers and one timer. Nothing is sent
 * anywhere; it is only ever shown to the person whose machine it describes,
 * through "Token Watch: Show Diagnostics".
 */

/** One thing that took time. */
export interface Span {
  name: string;
  /** Milliseconds it took. */
  ms: number;
  /** Milliseconds after the worker started, when it began. */
  atMs: number;
  /** Free-form count, where a duration alone would not say enough. */
  detail?: string;
}

/**
 * How long the worker went without letting the event loop turn.
 *
 * This is the number that explains an unresponsive panel: while the thread is
 * inside one of these, no query can be answered, however fast the query itself
 * would be.
 */
export interface Stall {
  ms: number;
  atMs: number;
}

const MAX_SPANS = 300;
const STALL_PROBE_INTERVAL_MS = 250;
/** Below this, a late timer is ordinary scheduling noise rather than a stall. */
const STALL_THRESHOLD_MS = 400;
const MAX_STALLS = 20;

const startedAt = Date.now();
const spans: Span[] = [];
const stalls: Stall[] = [];
let probe: ReturnType<typeof setInterval> | undefined;
let lastProbeAt = Date.now();

function sinceStart(): number {
  return Date.now() - startedAt;
}

function record(span: Span): void {
  spans.push(span);
  if (spans.length > MAX_SPANS) { spans.splice(0, spans.length - MAX_SPANS); }
}

/** Time a synchronous step. */
export function track<T>(name: string, fn: () => T, detail?: () => string): T {
  const atMs = sinceStart();
  const started = Date.now();
  try {
    return fn();
  } finally {
    record({ name, ms: Date.now() - started, atMs, ...(detail ? { detail: detail() } : {}) });
  }
}

/** Time an asynchronous step. */
export async function trackAsync<T>(name: string, fn: () => Promise<T>, detail?: () => string): Promise<T> {
  const atMs = sinceStart();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    record({ name, ms: Date.now() - started, atMs, ...(detail ? { detail: detail() } : {}) });
  }
}

/** Record something already measured. */
export function note(name: string, ms: number, detail?: string): void {
  record({ name, ms, atMs: sinceStart(), ...(detail ? { detail } : {}) });
}

/**
 * Start watching for stalls.
 *
 * A timer that should fire every 250 ms and fires late by a second was blocked
 * for that second, and so was every message waiting behind it.
 */
export function watchForStalls(): void {
  if (probe) { return; }
  lastProbeAt = Date.now();
  probe = setInterval(() => {
    const now = Date.now();
    const late = now - lastProbeAt - STALL_PROBE_INTERVAL_MS;
    lastProbeAt = now;
    if (late < STALL_THRESHOLD_MS) { return; }
    stalls.push({ ms: late, atMs: now - startedAt });
    stalls.sort((a, b) => b.ms - a.ms);
    if (stalls.length > MAX_STALLS) { stalls.length = MAX_STALLS; }
  }, STALL_PROBE_INTERVAL_MS);
  probe.unref?.();
}

export function stopWatchingForStalls(): void {
  if (!probe) { return; }
  clearInterval(probe);
  probe = undefined;
}

/** Everything recorded so far, newest spans last and worst stalls first. */
export function timeline(): { upMs: number; spans: Span[]; stalls: Stall[] } {
  return { upMs: sinceStart(), spans: [...spans], stalls: [...stalls] };
}
