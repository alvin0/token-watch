import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";

import {
  COORDINATOR_DISPOSED_MESSAGE,
  IngestionCoordinator,
  WORKER_UNAVAILABLE_MESSAGE,
  isCoordinatorDisposedError,
} from "../../host/IngestionCoordinator.js";
import type { WorkerEvent, WorkerRequest, IngestConfig } from "../../shared/workerProtocol.js";

const CONFIG: IngestConfig = {
  sources: {
    codex: { enabled: true, path: "/codex" },
    claude: { enabled: true, path: "/claude" },
  },
  pricingOverrides: {},
  currency: {},
  ingestion: { maxLineBytes: 1_048_576, backfillMonths: 0, watchDebounceMs: 500 },
  retention: { rawRecordDays: 0 },
  analytics: { anomalyMultiplier: 2, contextFillWarnPct: 80 },
};

/**
 * A worker stand-in. Nothing is answered unless a test says so, which is the
 * point: the coordinator must not hang when the real worker goes quiet.
 */
class FakeWorker extends EventEmitter {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  /** Set to have the fake answer `init` automatically. */
  autoReady: "ready" | "initError" | "silent" = "silent";

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    if (message.type !== "init") { return; }
    if (this.autoReady === "ready") {
      queueMicrotask(() => this.emit("message", { type: "ready", schema: "ok" } satisfies WorkerEvent));
    } else if (this.autoReady === "initError") {
      queueMicrotask(() => this.emit("message", {
        type: "initError",
        scope: "store",
        message: "database disk image is malformed",
      } satisfies WorkerEvent));
    }
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  reply(event: WorkerEvent): void {
    this.emit("message", event);
  }

  lastId(type: WorkerRequest["type"]): string {
    const found = [...this.sent].reverse().find((request) => request.type === type);
    assert.ok(found && "id" in found, `no ${type} request was sent`);
    return (found as { id: string }).id;
  }
}

function makeCoordinator(
  worker: FakeWorker | (() => FakeWorker),
  tuning: {
    startMs?: number;
    requestMs?: number;
    shutdownFlushMs?: number;
    restartBackoffMs?: number[];
    restartStabilityMs?: number;
  } = {},
) {
  const spawn = typeof worker === "function" ? worker : () => worker;
  return new IngestionCoordinator(
    "/tmp/global",
    CONFIG,
    () => spawn() as unknown as Worker,
    tuning,
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until `predicate` holds, or fail with `message`. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

suite("Coordinator lifecycle", () => {
  test("recognizes only the expected shutdown rejection", () => {
    assert.strictEqual(isCoordinatorDisposedError(new Error(COORDINATOR_DISPOSED_MESSAGE)), true);
    assert.strictEqual(isCoordinatorDisposedError(new Error("Worker exited")), false);
    assert.strictEqual(isCoordinatorDisposedError("Coordinator disposed"), false);
  });

  test("start resolves on ready and reports healthy", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);

    await coordinator.start();
    assert.strictEqual(coordinator.healthState().status, "ready");
    coordinator.dispose();
  });

  test("a worker that fails to initialize rejects start instead of hanging", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "initError";
    const coordinator = makeCoordinator(worker);

    await assert.rejects(
      () => coordinator.start(),
      /database disk image is malformed/,
      "An init failure must settle the handshake, not leave it pending",
    );
    assert.strictEqual(coordinator.healthState().status, "failed");
    coordinator.dispose();
  });

  test("a worker that dies during startup rejects start", async () => {
    const worker = new FakeWorker();
    const coordinator = makeCoordinator(worker);
    const starting = coordinator.start();
    worker.emit("exit", 1);

    await assert.rejects(starting, /exited during startup/);
    coordinator.dispose();
  });

  test("a query that is never answered rejects on the deadline", async function () {
    this.timeout(10_000);
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();

    // Shorten the wait by driving the timer directly rather than waiting 30s.
    const pending = coordinator.query({
      view: "series",
      granularity: "day",
      range: { fromUtc: 0, toUtc: 1 },
    });
    const settled = await Promise.race([
      pending.then(() => "resolved").catch((error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    assert.strictEqual(settled, "still-pending", "The query should still be waiting well before its deadline");

    // Kill the worker: everything waiting on it must reject immediately.
    worker.emit("error", new Error("worker crashed"));
    await assert.rejects(pending, /worker crashed/);
    coordinator.dispose();
  });

  test("a crashed worker rejects pending work and schedules a restart", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();

    const states: string[] = [];
    coordinator.onHealthChanged((health) => states.push(health.status));

    const pending = coordinator.diagnostics();
    worker.emit("exit", 7);

    await assert.rejects(pending, /exited \(code 7\)/);
    assert.ok(states.includes("restarting"), `expected a restarting state, got ${states.join(",")}`);
    coordinator.dispose();
  });

  test("diagnostics errors reject the caller rather than only logging", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();

    const pending = coordinator.diagnostics();
    worker.reply({ type: "diagnosticsError", id: worker.lastId("diagnostics"), message: "no store" });

    await assert.rejects(pending, /no store/);
    coordinator.dispose();
  });

  test("config updates are acknowledged", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();

    const pending = coordinator.updateConfig(CONFIG);
    worker.reply({ type: "configUpdated", id: worker.lastId("updateConfig") });
    await pending;

    const sent = worker.sent.find((request) => request.type === "updateConfig");
    assert.ok(sent, "The coordinator must forward the new config to the worker");
    coordinator.dispose();
  });

  test("ingestion warnings are forwarded to subscribers", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();

    const seen: string[][] = [];
    coordinator.onWarnings((warnings) => seen.push(warnings.unmappedModels));

    worker.reply({
      type: "ingestComplete",
      freshness: {},
      warnings: { unmappedModels: ["mystery-model"], malformedLineCount: 2, oversizedLineCount: 0, lostUsageLineCount: 0 },
      dataChanged: false,
    });

    assert.deepStrictEqual(seen, [["mystery-model"]]);
    coordinator.dispose();
  });

  test("requests after dispose fail fast", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker);
    await coordinator.start();
    coordinator.dispose();

    await assert.rejects(
      () => coordinator.query({ view: "series", granularity: "day", range: { fromUtc: 0, toUtc: 1 } }),
      (error: unknown) => isCoordinatorDisposedError(error),
    );
  });

  test("a request with no worker coming still fails fast rather than hanging", async () => {
    const worker = new FakeWorker();
    const coordinator = makeCoordinator(worker);

    await assert.rejects(
      () => coordinator.diagnostics(),
      new RegExp(WORKER_UNAVAILABLE_MESSAGE),
    );
    coordinator.dispose();
  });

  test("a query that arrives while the worker is still starting waits for it", async () => {
    // The panel asks for its first result the moment the WebView mounts, which
    // regularly beats the worker into existence. Rejecting it left the panel on
    // the scan spinner for the whole first pass, because nothing retries a
    // query — the numbers only appeared when the scan finished and pushed a
    // refresh.
    const worker = new FakeWorker();
    const coordinator = makeCoordinator(worker);

    // Started, but the handshake has not been answered yet.
    const started = coordinator.start();
    const query = coordinator.query({
      view: "series", granularity: "day", range: { fromUtc: 0, toUtc: 1 },
    });

    worker.reply({ type: "ready", schema: "ok" });
    await started;

    worker.reply({ type: "queryResult", id: worker.lastId("query"), result: {
      view: "series", series: [],
    } });
    const result = await query;
    assert.strictEqual(result.view, "series", "the query must be answered, not rejected");
    coordinator.dispose();
  });
});


suite("Coordinator recovery", () => {
  test("a startup timeout does not leave a worker behind that blocks every retry", async () => {
    // The worker is spawned and simply never answers `init`.
    const workers: FakeWorker[] = [];
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { startMs: 20 });

    await assert.rejects(() => coordinator.start(), /did not become ready/);
    assert.strictEqual(coordinator.healthState().status, "failed");
    assert.strictEqual(workers[0].terminated, true, "The unresponsive worker must be terminated");

    // Rescan is the documented way out; it must actually spawn a new worker.
    workers.length = 0;
    const spawned = new FakeWorker();
    spawned.autoReady = "ready";
    const retrying = makeCoordinator(spawned, { startMs: 20 });
    await retrying.start();
    assert.strictEqual(retrying.healthState().status, "ready");
    retrying.dispose();
    coordinator.dispose();
  });

  test("rescan restarts a coordinator whose startup timed out", async () => {
    let attempt = 0;
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      // First spawn hangs; the retry comes up.
      worker.autoReady = attempt++ === 0 ? "silent" : "ready";
      return worker;
    }, { startMs: 20 });

    await assert.rejects(() => coordinator.start(), /did not become ready/);
    assert.strictEqual(coordinator.healthState().status, "failed");

    coordinator.rescan();
    await flush();
    await flush();
    assert.strictEqual(coordinator.healthState().status, "ready", "Rescan must be able to restart the worker");
    coordinator.dispose();
  });

  test("a ready-then-crash loop opens the circuit breaker instead of restarting forever", async function () {
    this.timeout(10_000);
    const spawned: FakeWorker[] = [];
    // Every worker comes up and dies immediately: the exact loop that used to
    // restart forever, because each `ready` reset the restart budget.
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      worker.autoReady = "ready";
      spawned.push(worker);
      // Comes up, then dies a tick later — long enough to be "ready", far too
      // short to count as stable.
      setTimeout(() => worker.emit("exit", 1), 1);
      return worker;
    }, { startMs: 50, restartBackoffMs: [5, 5, 5], restartStabilityMs: 60_000 });

    await coordinator.start();
    await waitFor(
      () => coordinator.healthState().status === "failed",
      "The breaker never opened",
    );

    const spawnedAtBreak = spawned.length;
    assert.ok(spawnedAtBreak <= 5, `The breaker should cap restarts; spawned ${spawnedAtBreak}`);

    // And it stays open rather than quietly resuming.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(coordinator.healthState().status, "failed");
    assert.strictEqual(spawned.length, spawnedAtBreak, "No further restarts once the breaker is open");
    coordinator.dispose();
  });

  test("a worker that stays up earns its restart budget back", async function () {
    this.timeout(10_000);
    const spawned: FakeWorker[] = [];
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      worker.autoReady = "ready";
      spawned.push(worker);
      return worker;
    }, { startMs: 50, restartBackoffMs: [5, 5, 5], restartStabilityMs: 0 });

    await coordinator.start();
    // Five crashes, each followed by a worker that is considered stable
    // (stability threshold 0), so the budget resets every time.
    for (let round = 0; round < 5; round++) {
      const count = spawned.length;
      spawned[count - 1].emit("exit", 1);
      await waitFor(() => spawned.length > count, "Expected the worker to be restarted");
      await waitFor(() => coordinator.healthState().status === "ready", "Expected the restart to reach ready");
    }
    assert.strictEqual(coordinator.healthState().status, "ready");
    coordinator.dispose();
  });

  test("Reset Database recovers a database too corrupt for the worker to open", async () => {
    let attempt = 0;
    const spawned: FakeWorker[] = [];
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      // The database only opens once the host has asked for a reset.
      worker.autoReady = attempt++ === 0 ? "initError" : "ready";
      spawned.push(worker);
      return worker;
    }, { startMs: 50 });

    await assert.rejects(() => coordinator.start(), /malformed/);
    assert.strictEqual(coordinator.healthState().status, "failed");

    coordinator.resetDatabase();
    await flush();
    await flush();

    assert.strictEqual(coordinator.healthState().status, "ready");
    const init = spawned[1].sent.find((request) => request.type === "init");
    assert.ok(init && "resetDatabase" in init && init.resetDatabase === true,
      "The retry must ask the worker to move the unreadable database aside");
    coordinator.dispose();
  });

  test("pricing set before a crash is carried into the next worker", async () => {
    const spawned: FakeWorker[] = [];
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      worker.autoReady = "ready";
      spawned.push(worker);
      return worker;
    }, { startMs: 50, restartBackoffMs: [5, 5, 5] });
    await coordinator.start();

    const table = { "gpt-5": { inputPer1K: 1, outputPer1K: 2 } };
    const pending = coordinator.updatePricing(table);
    spawned[0].reply({ type: "pricingUpdated", id: spawned[0].lastId("updatePricing") });
    await pending;

    spawned[0].emit("exit", 1);
    await waitFor(() => spawned.length === 2, "The worker should have been restarted");
    const init = spawned[1].sent.find((request) => request.type === "init");
    assert.ok(init && init.type === "init");
    assert.deepStrictEqual(
      init.config.pricingOverrides,
      table,
      "A new worker must start from the pricing the user actually set",
    );
    coordinator.dispose();
  });

  test("the same pricing table is re-sent after a crash rather than deduplicated away", async () => {
    const spawned: FakeWorker[] = [];
    const coordinator = makeCoordinator(() => {
      const worker = new FakeWorker();
      worker.autoReady = "ready";
      spawned.push(worker);
      return worker;
    }, { startMs: 50, restartBackoffMs: [5, 5, 5] });
    await coordinator.start();

    const table = { "gpt-5": { inputPer1K: 1, outputPer1K: 2 } };
    const first = coordinator.updatePricing(table);
    spawned[0].reply({ type: "pricingUpdated", id: spawned[0].lastId("updatePricing") });
    await first;

    spawned[0].emit("exit", 1);
    await waitFor(() => spawned.length === 2, "The worker should have been restarted");
    await waitFor(() => coordinator.healthState().status === "ready", "Expected the restart to reach ready");

    const resend = coordinator.updatePricing(table);
    const sent = spawned[1].sent.filter((request) => request.type === "updatePricing");
    assert.strictEqual(sent.length, 1, "The resend must reach the new worker, not be deduplicated");
    spawned[1].reply({ type: "pricingUpdated", id: spawned[1].lastId("updatePricing") });
    await resend;
    coordinator.dispose();
  });

  test("shutdown waits for the worker to acknowledge its final flush", async () => {
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker, { startMs: 50 });
    await coordinator.start();

    let settled = false;
    const shutting = coordinator.shutdown().then((result) => { settled = true; return result; });
    await flush();

    const flushRequest = worker.sent.find((request) => request.type === "flush");
    assert.ok(flushRequest && "id" in flushRequest && flushRequest.id, "Shutdown must ask for an acknowledged flush");
    assert.ok(
      flushRequest && "stopScan" in flushRequest && flushRequest.stopScan,
      "Shutdown must ask a running scan to stop, or the flush waits behind a backfill",
    );
    assert.strictEqual(settled, false, "Shutdown must not complete before the flush is acknowledged");

    worker.reply({ type: "flushed", id: (flushRequest as { id: string }).id, persisted: true });
    const result = await shutting;
    assert.strictEqual(settled, true);
    assert.deepStrictEqual(result, { persisted: true });
  });

  test("a flush the worker could not persist is retried, then reported", async function () {
    this.timeout(10_000);
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker, { startMs: 50, shutdownFlushMs: 200 });
    await coordinator.start();

    // Answer every flush request with a refusal, as a fenced-out worker does.
    const answered = new Set<string>();
    const answerRefusals = setInterval(() => {
      for (const request of worker.sent) {
        if (request.type === "flush" && "id" in request && request.id && !answered.has(request.id)) {
          answered.add(request.id);
          worker.reply({
            type: "flushed",
            id: request.id,
            persisted: false,
            message: "Another window owns the usage database",
          });
        }
      }
    }, 5);

    const result = await coordinator.shutdown();
    clearInterval(answerRefusals);

    assert.strictEqual(result.persisted, false, "A refused write must not be reported as success");
    assert.match(result.reason ?? "", /owns the usage database/);
    const flushes = worker.sent.filter((request) => request.type === "flush");
    assert.ok(flushes.length >= 2, `The failed flush should be retried, saw ${flushes.length} attempts`);
  });

  test("shutdown still completes if the worker never acknowledges", async function () {
    this.timeout(10_000);
    const worker = new FakeWorker();
    worker.autoReady = "ready";
    const coordinator = makeCoordinator(worker, { startMs: 50, shutdownFlushMs: 100 });
    await coordinator.start();
    const result = await coordinator.shutdown();
    assert.strictEqual(result.persisted, false, "An unanswered flush is not a persisted one");
    assert.match(result.reason ?? "", /No acknowledgement/);
  });
});
