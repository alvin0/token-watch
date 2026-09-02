import * as vscode from "vscode";
import { Worker } from "worker_threads";
import { join } from "path";
import { randomUUID } from "crypto";
import type { WorkerRequest, WorkerEvent, IngestConfig } from "../shared/workerProtocol.js";
import type { AnalyticsQuery, AnalyticsResult, DiagnosticsReport, FreshnessInfo, WarningInfo } from "../shared/protocol.js";
import type { PricingTable } from "../shared/types.js";

export const COORDINATOR_DISPOSED_MESSAGE = "Coordinator disposed";
export const WORKER_UNAVAILABLE_MESSAGE = "Worker not available";

/** Deadlines. A worker that never answers must not hang activation or a query. */
export const WORKER_START_TIMEOUT_MS = 60_000;
export const WORKER_REQUEST_TIMEOUT_MS = 30_000;
/** A reset re-reads every log, so it needs far longer than a query. */
export const RESET_TIMEOUT_MS = 10 * 60_000;

/** Restart policy: three attempts inside the window, then the breaker opens. */
const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000];
const RESTART_WINDOW_MS = 5 * 60_000;
/**
 * How long a worker must stay ready before its restart is called a success.
 *
 * Resetting the counter the instant a worker says `ready` makes the breaker
 * useless against the common failure: a worker that starts, crashes on its
 * first scan, starts again, crashes again — forever, because each `ready`
 * wiped the evidence.
 */
const RESTART_STABILITY_MS = 60_000;
/**
 * Time allowed for one final-flush attempt to be acknowledged.
 *
 * The worker stops its scan at the next file or batch boundary when asked, so
 * this only has to cover writing the snapshot, not finishing a backfill. Two
 * attempts are made, so the worst case is twice this.
 */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 10_000;
/** A failed flush is retried once before the worker is terminated regardless. */
const SHUTDOWN_FLUSH_ATTEMPTS = 2;

export type CoordinatorHealth =
  /** Worker spawned, `ready` not yet received. */
  | "starting"
  /** Worker answered `ready`; requests are served. */
  | "ready"
  /** Worker died; a restart is scheduled. */
  | "restarting"
  /** Restart budget exhausted, or start failed outright. Requests fail fast. */
  | "failed";

/** What happened to the worker's final write. */
export interface ShutdownResult {
  /** False when the snapshot did not reach disk before the worker was stopped. */
  persisted: boolean;
  reason?: string;
}

export interface CoordinatorHealthState {
  status: CoordinatorHealth;
  /** Last error that took the worker down, if any. */
  message?: string;
  /** Restarts attempted inside the current window. */
  restarts: number;
}

export function isCoordinatorDisposedError(error: unknown): boolean {
  return error instanceof Error && error.message === COORDINATOR_DISPOSED_MESSAGE;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The worker's answer to a `flush` request. */
interface FlushAck {
  persisted: boolean;
  message?: string;
}

export class IngestionCoordinator implements vscode.Disposable {
  private worker: Worker | null = null;
  /**
   * The startup or restart currently in progress, if any.
   *
   * The panel asks for its first result the moment the WebView mounts, which
   * regularly beats the worker into existence. Rejecting that request left the
   * panel on a spinner for the whole first scan — nothing retries a query — so
   * a request that arrives too early waits for the worker instead.
   */
  private starting: Promise<void> | undefined;
  private pendingQueries = new Map<string, PendingRequest<AnalyticsResult>>();
  private pendingDiagnostics = new Map<string, PendingRequest<DiagnosticsReport>>();
  private pendingConfigUpdates = new Map<string, PendingRequest<void>>();
  private pendingPricingUpdates = new Map<string, {
    fingerprint: string;
    timer: ReturnType<typeof setTimeout>;
    waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  }>();
  private pricingUpdateIdsByFingerprint = new Map<string, string>();
  private lastAppliedPricingFingerprint: string | undefined;
  private readonly _onChanged = new vscode.EventEmitter<FreshnessInfo>();
  readonly onChanged = this._onChanged.event;
  private readonly _onScanComplete = new vscode.EventEmitter<FreshnessInfo>();
  readonly onScanComplete = this._onScanComplete.event;
  private readonly _onWarnings = new vscode.EventEmitter<WarningInfo>();
  /** Non-fatal ingestion warnings, forwarded so the UI can render them (Req 15.2, 15.3). */
  readonly onWarnings = this._onWarnings.event;
  private readonly _onProgress = new vscode.EventEmitter<{ processed: number; total: number; partial: boolean }>();
  readonly onProgress = this._onProgress.event;
  private readonly _onHealthChanged = new vscode.EventEmitter<CoordinatorHealthState>();
  readonly onHealthChanged = this._onHealthChanged.event;
  private disposed = false;
  private health: CoordinatorHealth = "starting";
  private healthMessage: string | undefined;
  private restartsInWindow = 0;
  private restartWindowStartedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readySince: number | undefined;
  /**
   * Set when a reset is requested while no worker is alive. A database too
   * corrupt to open fails `init`, so the only way back is to tell the next
   * worker to move it aside before opening.
   */
  private resetOnNextInit = false;
  private pendingFlushes = new Map<string, PendingRequest<FlushAck>>();
  private pendingResets = new Map<string, PendingRequest<number>>();
  private shutdownPromise: Promise<ShutdownResult> | undefined;
  private config: IngestConfig;

  private readonly startTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownFlushMs: number;
  private readonly restartBackoffMs: number[];
  private readonly restartStabilityMs: number;

  constructor(
    private readonly globalStoragePath: string,
    config: IngestConfig,
    /** Injected for tests; defaults to spawning the real worker thread. */
    private readonly spawnWorker: () => Worker = () => new Worker(join(__dirname, "ingestionWorker.js")),
    /** Shortened by tests so deadline and restart behaviour run in-process. */
    tuning: {
      startMs?: number;
      requestMs?: number;
      shutdownFlushMs?: number;
      restartBackoffMs?: number[];
      restartStabilityMs?: number;
    } = {},
  ) {
    this.config = config;
    this.startTimeoutMs = tuning.startMs ?? WORKER_START_TIMEOUT_MS;
    this.requestTimeoutMs = tuning.requestMs ?? WORKER_REQUEST_TIMEOUT_MS;
    this.shutdownFlushMs = tuning.shutdownFlushMs ?? SHUTDOWN_FLUSH_TIMEOUT_MS;
    this.restartBackoffMs = tuning.restartBackoffMs ?? RESTART_BACKOFF_MS;
    this.restartStabilityMs = tuning.restartStabilityMs ?? RESTART_STABILITY_MS;
  }

  healthState(): CoordinatorHealthState {
    return {
      status: this.health,
      ...(this.healthMessage ? { message: this.healthMessage } : {}),
      restarts: this.restartsInWindow,
    };
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error(COORDINATOR_DISPOSED_MESSAGE);
    }
    const startup = this.startWorker();
    this.starting = startup.then(() => undefined, () => undefined);
    return startup;
  }

  private async startWorker(): Promise<void> {
    this.setHealth("starting");
    let worker: Worker;
    try {
      worker = await this.spawnAndHandshake();
    } catch (error) {
      // The handshake can fail with the worker still alive — a startup timeout
      // leaves it running and unresponsive. Leaving the reference in place made
      // every later restart a no-op, because restartNow() bails when a worker
      // object exists.
      this.discardWorker();
      this.setHealth("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (this.worker !== worker) {
      // It already died; handleWorkerDown owns the health state now.
      throw new Error(this.healthMessage ?? "Worker stopped during startup");
    }
    this.setHealth("ready");
  }

  async query(q: AnalyticsQuery): Promise<AnalyticsResult> {
    return this.request<AnalyticsResult>(this.pendingQueries, (id) => ({ type: "query", id, query: q }), "query");
  }

  async diagnostics(): Promise<DiagnosticsReport> {
    return this.request<DiagnosticsReport>(this.pendingDiagnostics, (id) => ({ type: "diagnostics", id }), "diagnostics");
  }

  scanAndIngest(reason: "activation" | "watch" | "manual", changedPaths?: string[]): void {
    this.send({ type: "scanAndIngest", reason, changedPaths });
  }

  rescan(): void {
    // A manual rescan is also the user's way out of an open circuit breaker.
    if (!this.worker && !this.disposed) {
      void this.restartNow({ resetBreaker: true });
      return;
    }
    this.send({ type: "scanAndIngest", reason: "manual", forceFull: true });
  }

  /**
   * Clear the database and rebuild from logs. Resolves with the number of
   * records the rebuild produced, so the command can tell the user what
   * happened instead of failing silently.
   */
  resetDatabase(): Promise<number> {
    if (this.disposed) {
      return Promise.reject(new Error(COORDINATOR_DISPOSED_MESSAGE));
    }
    if (this.worker) {
      return this.request<number>(
        this.pendingResets,
        (id) => ({ type: "resetDatabase", id }),
        "database reset",
        RESET_TIMEOUT_MS,
      );
    }
    // No worker to ask. The usual reason is a database so damaged that `init`
    // itself throws, which is exactly the case a user reaches for Reset
    // Database to fix — so carry the request into the next handshake.
    this.resetOnNextInit = true;
    return this.restartNow({ resetBreaker: true }).then(() => {
      if (this.health !== "ready") {
        throw new Error(this.healthMessage ?? "The worker could not be restarted");
      }
      return 0;
    });
  }

  /**
   * Push changed settings to the running worker. Source toggles/paths,
   * debounce, max line bytes and backfill used to require a window reload.
   */
  updateConfig(config: IngestConfig): Promise<void> {
    this.config = config;
    return this.request<void>(
      this.pendingConfigUpdates,
      (id) => ({ type: "updateConfig", id, config }),
      "config update",
    );
  }

  updatePricing(table: PricingTable): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error(COORDINATOR_DISPOSED_MESSAGE));
    }
    // Record the table even when it cannot be delivered right now: it is the
    // pricing the user asked for, and the next worker must start with it.
    this.config = { ...this.config, pricingOverrides: table };
    if (!this.worker) {
      return Promise.reject(new Error(WORKER_UNAVAILABLE_MESSAGE));
    }
    const fingerprint = JSON.stringify(table);
    if (fingerprint === this.lastAppliedPricingFingerprint) {
      return Promise.resolve();
    }
    const existingId = this.pricingUpdateIdsByFingerprint.get(fingerprint);
    if (existingId) {
      const existing = this.pendingPricingUpdates.get(existingId);
      if (existing) {
        return new Promise<void>((resolve, reject) => {
          existing.waiters.push({ resolve, reject });
        });
      }
    }
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePricingUpdate(id, new Error("Timed out waiting for the worker (pricing update)"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pendingPricingUpdates.set(id, { fingerprint, timer, waiters: [{ resolve, reject }] });
      this.pricingUpdateIdsByFingerprint.set(fingerprint, id);
      this.send({ type: "updatePricing", id, table });
    });
  }

  /**
   * Flush the worker's database and terminate it, waiting for the write to be
   * acknowledged.
   *
   * `dispose()` cannot await, so `deactivate()` awaits this instead: a
   * fire-and-terminate-in-200ms shutdown threw away whatever the current scan
   * had ingested since the last snapshot.
   */
  shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise) { return this.shutdownPromise; }
    if (!this.worker) {
      this.dispose();
      return Promise.resolve({ persisted: true });
    }

    this.shutdownPromise = this.flushUntilPersisted().then((result) => {
      if (!result.persisted) {
        // Reported, not swallowed: the panel's numbers on next start will be
        // whatever the last successful write held, and the user deserves to
        // know why they went backwards.
        console.error(
          `[TokenWatch] shutting down without a persisted snapshot: ${result.reason ?? "unknown reason"}`,
        );
      }
      this.dispose();
      return result;
    });
    return this.shutdownPromise;
  }

  /**
   * Ask the worker to flush, retrying once if it reports the write did not
   * land. VS Code cannot be held open indefinitely, so the worker is stopped
   * either way — but the outcome is returned rather than assumed.
   */
  private async flushUntilPersisted(): Promise<ShutdownResult> {
    let last: FlushAck = { persisted: false, message: "The worker never answered" };

    for (let attempt = 0; attempt < SHUTDOWN_FLUSH_ATTEMPTS; attempt++) {
      if (!this.worker) {
        return { persisted: false, reason: "The worker stopped before the snapshot was written" };
      }
      last = await this.requestFlush();
      if (last.persisted) {
        return { persisted: true };
      }
    }
    return { persisted: false, ...(last.message ? { reason: last.message } : {}) };
  }

  private requestFlush(): Promise<FlushAck> {
    const id = randomUUID();
    return new Promise<FlushAck>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFlushes.delete(id);
        resolve({ persisted: false, message: `No acknowledgement within ${this.shutdownFlushMs}ms` });
      }, this.shutdownFlushMs);
      timer.unref?.();
      this.pendingFlushes.set(id, {
        resolve,
        reject: (error) => resolve({ persisted: false, message: error.message }),
        timer,
      });
      // `stopScan` bounds the wait to the current batch instead of a whole
      // backfill, which the timeout above would otherwise cut short.
      this.send({ type: "flush", id, stopScan: true });
    });
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.clearStarting();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    if (this.worker) {
      // Reached without a prior shutdown() (an unexpected teardown). Ask for a
      // flush and give the worker a moment; its beforeExit handler is the
      // remaining safety net.
      this.send({ type: "flush" });
      const w = this.worker;
      this.worker = null;
      const terminateTimer = setTimeout(() => { void w.terminate(); }, 200);
      terminateTimer.unref?.();
    }

    this.rejectAllPending(COORDINATOR_DISPOSED_MESSAGE);
    this._onChanged.dispose();
    this._onScanComplete.dispose();
    this._onWarnings.dispose();
    this._onProgress.dispose();
    this._onHealthChanged.dispose();
  }

  // --- Private ---

  /**
   * Spawn a worker and wait for its handshake. Returns the worker so the caller
   * can check it is still the current one: a worker can die between `ready` and
   * the `await` resuming, and stamping "ready" over that crash left the
   * coordinator claiming health it did not have, with no worker attached.
   */
  private async spawnAndHandshake(): Promise<Worker> {
    const worker = this.spawnWorker();
    this.worker = worker;
    this.setupListeners(worker);

    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        clearTimeout(timer);
      };
      const onMessage = (event: WorkerEvent) => {
        if (event.type === "ready") {
          cleanup();
          resolve();
        } else if (event.type === "initError") {
          cleanup();
          reject(new Error(`Worker init failed (${event.scope}): ${event.message}`));
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`Worker exited during startup (code ${code})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Worker did not become ready within ${this.startTimeoutMs}ms`));
      }, this.startTimeoutMs);
      timer.unref?.();

      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
    });

    const dbPath = join(this.globalStoragePath, "token-watch-v8.db");
    const previousDbPath = join(this.globalStoragePath, "token-watch-v7.db");
    const legacyDbPath = join(this.globalStoragePath, "token-watch.db");
    const resetDatabase = this.resetOnNextInit;
    this.resetOnNextInit = false;
    this.send({
      type: "init",
      dbPath,
      previousDbPath,
      legacyDbPath,
      config: this.config,
      ...(resetDatabase ? { resetDatabase: true } : {}),
    });

    await ready;
    return worker;
  }

  private request<T>(
    pending: Map<string, PendingRequest<T>>,
    build: (id: string) => WorkerRequest,
    label: string,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error(COORDINATOR_DISPOSED_MESSAGE));
    }
    if (!this.worker) {
      // Only worth waiting for if one is actually coming.
      if (!this.starting) {
        return Promise.reject(new Error(WORKER_UNAVAILABLE_MESSAGE));
      }
      return this.starting.then(() => {
        if (this.disposed) { throw new Error(COORDINATOR_DISPOSED_MESSAGE); }
        if (!this.worker) { throw new Error(WORKER_UNAVAILABLE_MESSAGE); }
        return this.request<T>(pending, build, label, timeoutMs);
      });
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for the worker (${label})`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      this.send(build(id));
    });
  }

  private settle<T>(pending: Map<string, PendingRequest<T>>, id: string, value: T): void {
    const entry = pending.get(id);
    if (!entry) { return; }
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
  }

  private settleError<T>(pending: Map<string, PendingRequest<T>>, id: string, message: string): void {
    const entry = pending.get(id);
    if (!entry) { return; }
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }

  private send(req: WorkerRequest): void {
    // Serialize via JSON to ensure the message is a plain, cloneable object.
    // VS Code config proxies and undefined values are not structured-cloneable.
    this.worker?.postMessage(JSON.parse(JSON.stringify(req)));
  }

  private setupListeners(worker: Worker): void {
    worker.on("message", (event: WorkerEvent) => {
      if (this.worker !== worker) { return; }
      switch (event.type) {
        case "queryResult":
          this.settle(this.pendingQueries, event.id, event.result);
          break;
        case "queryError":
          this.settleError(this.pendingQueries, event.id, event.message);
          break;
        case "diagnosticsResult":
          this.settle(this.pendingDiagnostics, event.id, event.result);
          break;
        case "diagnosticsError":
          this.settleError(this.pendingDiagnostics, event.id, event.message);
          break;
        case "configUpdated":
          this.settle(this.pendingConfigUpdates, event.id, undefined as void);
          break;
        case "resetComplete":
          this.settle(this.pendingResets, event.id, event.records);
          break;
        case "resetError":
          this.settleError(this.pendingResets, event.id, event.message);
          break;
        case "flushed":
          this.settle(this.pendingFlushes, event.id, {
            persisted: event.persisted,
            ...(event.message ? { message: event.message } : {}),
          });
          break;
        case "configUpdateError":
          this.settleError(this.pendingConfigUpdates, event.id, event.message);
          break;
        case "pricingUpdated":
          this.settlePricingUpdate(event.id);
          break;
        case "pricingUpdateError":
          this.settlePricingUpdate(event.id, new Error(event.message));
          break;
        case "ingestComplete":
          this._onScanComplete.fire(event.freshness);
          this._onWarnings.fire(event.warnings);
          if (event.dataChanged) {
            this._onChanged.fire(event.freshness);
          }
          break;
        case "error":
          // Log but don't crash the coordinator
          console.error(`[TokenWatch worker] ${event.scope}: ${event.message}`);
          break;
        case "initError":
          // A late init failure (after the handshake resolved) still means the
          // worker is unusable; treat it as a crash so the restart path runs.
          this.handleWorkerDown(worker, `init failed: ${event.message}`);
          break;
        case "progress":
          this._onProgress.fire({ processed: event.processed, total: event.total, partial: event.partial });
          break;
        case "ready":
          // Handled by the handshake promise.
          break;
      }
    });

    worker.on("error", (err) => {
      this.handleWorkerDown(worker, `Worker error: ${err.message}`);
    });

    worker.on("exit", (code) => {
      this.handleWorkerDown(worker, `Worker exited (code ${code})`);
    });
  }

  /**
   * A worker died outside dispose. Reject everything waiting on it, then either
   * schedule a restart or open the circuit breaker if it keeps dying.
   */
  private handleWorkerDown(worker: Worker, reason: string): void {
    if (this.disposed || this.worker !== worker) { return; }
    console.error(`[TokenWatch worker] ${reason}`);
    this.worker = null;
    // A worker that dies has not applied anything; a resend of the same pricing
    // table must not be deduplicated away as "already applied".
    this.lastAppliedPricingFingerprint = undefined;
    this.rejectAllPending(reason);
    void worker.terminate().catch(() => undefined);

    const now = Date.now();
    // Only a worker that stayed up counts as a recovery. Without this a
    // ready-then-crash loop resets the budget on every cycle and restarts
    // forever.
    const wasStable = this.readySince !== undefined && now - this.readySince >= this.restartStabilityMs;
    this.readySince = undefined;
    if (wasStable || now - this.restartWindowStartedAt > RESTART_WINDOW_MS) {
      this.restartWindowStartedAt = now;
      this.restartsInWindow = 0;
    }

    if (this.restartsInWindow >= this.restartBackoffMs.length) {
      this.setHealth(
        "failed",
        `${reason} — restarted ${this.restartsInWindow} times; giving up until "Token Watch: Rescan Logs" is run.`,
      );
      return;
    }

    const delay = this.restartBackoffMs[Math.min(this.restartsInWindow, this.restartBackoffMs.length - 1)];
    this.restartsInWindow++;
    this.setHealth("restarting", reason);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restartNow();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async restartNow(options: { resetBreaker?: boolean } = {}): Promise<void> {
    if (this.disposed || this.worker) { return; }
    const attempt = this.restartWorker(options);
    this.starting = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  private async restartWorker({ resetBreaker = false }: { resetBreaker?: boolean } = {}): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (resetBreaker) {
      // An explicit user action re-arms the breaker; otherwise "Rescan Logs"
      // could only ever buy one attempt.
      this.restartsInWindow = 0;
      this.restartWindowStartedAt = Date.now();
    }
    this.setHealth("starting");
    let worker: Worker;
    try {
      worker = await this.spawnAndHandshake();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.discardWorker();
      this.setHealth("failed", message);
      return;
    }
    if (this.worker !== worker) {
      // Died between `ready` and here; handleWorkerDown has already decided
      // whether to schedule another attempt or open the breaker.
      return;
    }
    this.setHealth("ready");
    // A restarted worker starts from the persisted db; catch it back up.
    this.scanAndIngest("activation");
  }

  /** Drop the current worker reference and terminate it in the background. */
  /** Whatever was on its way is not coming any more. */
  private clearStarting(): void {
    this.starting = undefined;
  }

  private discardWorker(): void {
    const worker: Worker | null = this.worker;
    this.worker = null;
    void worker?.terminate().catch(() => undefined);
  }

  private setHealth(status: CoordinatorHealth, message?: string): void {
    this.health = status;
    this.healthMessage = status === "ready" ? undefined : message ?? this.healthMessage;
    // The restart budget is NOT cleared here. A worker only earns its budget
    // back by staying up (see RESTART_STABILITY_MS in handleWorkerDown) or by
    // an explicit user rescan; clearing it on every `ready` let a
    // ready-then-crash loop restart without limit.
    this.readySince = status === "ready" ? Date.now() : undefined;
    if (!this.disposed) {
      this._onHealthChanged.fire(this.healthState());
    }
  }

  private rejectAllPending(reason: string): void {
    for (const map of [this.pendingQueries, this.pendingDiagnostics, this.pendingConfigUpdates, this.pendingFlushes, this.pendingResets] as Array<Map<string, PendingRequest<unknown>>>) {
      for (const [id, entry] of map) {
        map.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
    }
    for (const [id, pending] of this.pendingPricingUpdates) {
      clearTimeout(pending.timer);
      for (const waiter of pending.waiters) {
        waiter.reject(new Error(reason));
      }
      this.pricingUpdateIdsByFingerprint.delete(pending.fingerprint);
      this.pendingPricingUpdates.delete(id);
    }
  }

  private settlePricingUpdate(id: string, error?: Error): void {
    const pending = this.pendingPricingUpdates.get(id);
    if (!pending) { return; }
    this.pendingPricingUpdates.delete(id);
    this.pricingUpdateIdsByFingerprint.delete(pending.fingerprint);
    clearTimeout(pending.timer);
    if (!error) {
      this.lastAppliedPricingFingerprint = pending.fingerprint;
    }
    for (const waiter of pending.waiters) {
      if (error) { waiter.reject(error); } else { waiter.resolve(); }
    }
  }
}
