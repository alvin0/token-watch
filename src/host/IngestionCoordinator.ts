import * as vscode from "vscode";
import { Worker } from "worker_threads";
import { join } from "path";
import { randomUUID } from "crypto";
import type { WorkerRequest, WorkerEvent, IngestConfig } from "../shared/workerProtocol.js";
import type { AnalyticsQuery, AnalyticsResult, FreshnessInfo } from "../shared/protocol.js";
import type { PricingTable } from "../shared/types.js";

export class IngestionCoordinator implements vscode.Disposable {
  private worker: Worker | null = null;
  private pendingQueries = new Map<string, { resolve: (r: AnalyticsResult) => void; reject: (e: Error) => void }>();
  private readonly _onChanged = new vscode.EventEmitter<FreshnessInfo>();
  readonly onChanged = this._onChanged.event;
  private readonly _onProgress = new vscode.EventEmitter<{ processed: number; total: number; partial: boolean }>();
  readonly onProgress = this._onProgress.event;
  private disposed = false;

  constructor(
    private readonly globalStoragePath: string,
    private readonly config: IngestConfig,
  ) {}

  async start(): Promise<void> {
    const workerPath = join(__dirname, "ingestionWorker.js");
    this.worker = new Worker(workerPath);

    const readyPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (event: WorkerEvent) => {
        if (event.type === "ready") {
          this.worker!.off("message", onMessage);
          this.worker!.off("error", onError);
          resolve();
        }
      };
      const onError = (err: Error) => {
        this.worker!.off("message", onMessage);
        reject(err);
      };
      this.worker!.on("message", onMessage);
      this.worker!.once("error", onError);
    });

    this.setupListeners();

    const dbPath = join(this.globalStoragePath, "token-watch.db");
    this.send({ type: "init", dbPath, config: this.config });

    await readyPromise;
  }

  async query(q: AnalyticsQuery): Promise<AnalyticsResult> {
    if (!this.worker) {
      throw new Error("Worker not available");
    }
    const id = randomUUID();
    return new Promise<AnalyticsResult>((resolve, reject) => {
      this.pendingQueries.set(id, { resolve, reject });
      this.send({ type: "query", id, query: q });
    });
  }

  scanAndIngest(reason: "activation" | "watch" | "manual", changedPaths?: string[]): void {
    this.send({ type: "scanAndIngest", reason, changedPaths });
  }

  rescan(): void {
    this.send({ type: "scanAndIngest", reason: "manual", forceFull: true });
  }

  updatePricing(table: PricingTable): void {
    this.send({ type: "updatePricing", table });
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;

    if (this.worker) {
      // Send flush and wait briefly for it to be processed before terminating.
      // The worker's beforeExit handler also calls flush as a safety net.
      this.send({ type: "flush" });
      const w = this.worker;
      this.worker = null;
      // Give the worker a short window to process the flush message
      setTimeout(() => { w.terminate(); }, 200);
    }

    this.rejectAllPending("Coordinator disposed");
    this._onChanged.dispose();
    this._onProgress.dispose();
  }

  // --- Private ---

  private send(req: WorkerRequest): void {
    // Serialize via JSON to ensure the message is a plain, cloneable object.
    // VS Code config proxies and undefined values are not structured-cloneable.
    this.worker?.postMessage(JSON.parse(JSON.stringify(req)));
  }

  private setupListeners(): void {
    if (!this.worker) { return; }

    this.worker.on("message", (event: WorkerEvent) => {
      switch (event.type) {
        case "queryResult": {
          const pending = this.pendingQueries.get(event.id);
          if (pending) {
            this.pendingQueries.delete(event.id);
            pending.resolve(event.result);
          }
          break;
        }
        case "ingestComplete":
          this._onChanged.fire(event.freshness);
          break;
        case "error":
          // Log but don't crash the coordinator
          console.error(`[TokenWatch worker] ${event.scope}: ${event.message}`);
          break;
        case "progress":
          this._onProgress.fire({ processed: event.processed, total: event.total, partial: event.partial });
          break;
        case "ready":
          // Handled elsewhere or informational
          break;
      }
    });

    this.worker.on("error", (err) => {
      console.error("[TokenWatch worker] error:", err.message);
      this.worker = null;
      this.rejectAllPending("Worker error: " + err.message);
    });

    this.worker.on("exit", (code) => {
      if (!this.disposed) {
        console.error(`[TokenWatch worker] exited with code ${code}`);
        this.worker = null;
        this.rejectAllPending(`Worker exited (code ${code})`);
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, { reject }] of this.pendingQueries) {
      reject(new Error(reason));
      this.pendingQueries.delete(id);
    }
  }
}
