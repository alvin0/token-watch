/**
 * Worker-threads entry point for the ingestion worker.
 *
 * Loads sql.js (wasm), opens/migrates the UsageStore, creates the PricingEngine
 * and AnalyticsService, then dispatches WorkerRequest messages from the host.
 *
 * This module MUST NOT import `vscode`.
 */

import { parentPort } from "worker_threads";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { UsageStore } from "./store/UsageStore.js";
import { PricingEngine } from "./pricing.js";
import { AnalyticsService } from "./analytics.js";
import { DEFAULT_PRICING, FALLBACK_RATE } from "../shared/defaultPricing.js";
import { scan } from "./discovery.js";
import { ingestAll } from "./ingest.js";
import type { WorkerRequest, WorkerEvent, IngestConfig } from "../shared/workerProtocol.js";

let store: UsageStore | undefined;
let pricing: PricingEngine | undefined;
let analytics: AnalyticsService | undefined;
let config: IngestConfig | undefined;

function post(event: WorkerEvent): void {
  parentPort!.postMessage(event);
}

/**
 * Sanitize error messages to never include raw log content.
 * Returns only the error message string, truncated if excessively long.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 200 ? err.message.slice(0, 200) : err.message;
  }
  return "Unknown error";
}

/**
 * Classify an error into a structured scope for the host.
 */
function classifyErrorScope(err: unknown, fallbackScope: string): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "ENOENT" || code === "EPERM") {
      return "permission";
    }
    // sql.js failures during open/query
    if (
      err.message.includes("not a database") ||
      err.message.includes("database disk image is malformed") ||
      err.message.includes("SQL") ||
      err.message.includes("sqlite")
    ) {
      return "store";
    }
  }
  return fallbackScope;
}

async function handleInit(req: Extract<WorkerRequest, { type: "init" }>): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(__dirname, file),
  });

  store = new UsageStore();
  await store.open(req.dbPath, SQL);
  const schema = await store.migrateOrRebuild();

  config = req.config;

  // Merge default pricing with user overrides
  const mergedTable = { ...DEFAULT_PRICING, ...req.config.pricingOverrides };
  pricing = new PricingEngine(mergedTable, FALLBACK_RATE);

  analytics = new AnalyticsService(store.database, pricing);

  post({ type: "ready", schema });
}

// Flush-on-terminate: persist the db before the worker exits.
process.on("beforeExit", () => {
  if (store) {
    try {
      store.flush();
    } catch {
      // Best-effort; worker is exiting.
    }
  }
});

parentPort!.on("message", (req: WorkerRequest) => {
  (async () => {
    switch (req.type) {
      case "init":
        await handleInit(req);
        break;

      case "query": {
        if (!analytics) {
          post({ type: "error", scope: "query", message: "Worker not initialized" });
          return;
        }
        const result = analytics.query(req.query);
        post({ type: "queryResult", id: req.id, result });
        break;
      }

      case "scanAndIngest": {
        if (!store || !pricing || !analytics || !config) {
          post({ type: "error", scope: "scanAndIngest", message: "Worker not initialized" });
          return;
        }

        // Discover candidate files from configured source roots
        const candidates = scan({
          codex: config.sources.codex.enabled
            ? { enabled: true, path: config.sources.codex.path ?? "" }
            : undefined,
          claude: config.sources.claude.enabled
            ? { enabled: true, path: config.sources.claude.path ?? "" }
            : undefined,
        });

        // forceFull (manual rescan): wipe existing data, parse from offset 0
        if (req.forceFull) {
          for (const c of candidates) {
            const cursor = store.getCursor(c.filePath);
            if (cursor) {
              store.subtractFileContribution(cursor.fileId);
              store.deleteFileRows(cursor.fileId);
              store.deleteCursor(c.filePath);
            }
          }
        }

        const options = {
          maxLineBytes: config.ingestion.maxLineBytes,
          backfillMonths: req.forceFull ? 0 : config.ingestion.backfillMonths,
        };

        await ingestAll(candidates, store, pricing, options, (processed, total) => {
          post({ type: "progress", processed, total, partial: true });
        });

        store.flush();
        post({
          type: "ingestComplete",
          freshness: analytics.freshness(),
          warnings: analytics.warnings(),
        });
        break;
      }

      case "updatePricing":
        // Placeholder — wired in task 8.3
        break;

      case "flush":
        if (store) {
          store.flush();
        }
        break;
    }
  })().catch((err: unknown) => {
    const scope = classifyErrorScope(err, req.type);
    const message = sanitizeErrorMessage(err);
    post({ type: "error", scope, message });
  });
});
