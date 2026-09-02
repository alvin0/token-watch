import * as assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { hasIngestedChanges, ingestAll, ingestFile, isPartialIngestError } from "../../worker/ingest.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { mergePricingConfig } from "../../shared/pricingMerge.js";
import { rebuildAggregates, dailySeries } from "../../worker/store/queries.js";
import { FileQuarantine } from "../../worker/quarantine.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { IngestResult } from "../../worker/ingest.js";
import { CODEX_ROLLOUT_JSONL } from "../fixtures/codexRollout.js";

function emptyResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    processed: 0,
    skipped: 0,
    appended: 0,
    reingested: 0,
    firstReads: 0,
    failed: 0,
    quarantined: 0,
    oversizedRecovered: 0,
    oversizedLostUsage: 0,
    partialCommits: 0,
    stoppedEarly: false,
    ...overrides,
  };
}

suite("Partial ingest accounting", () => {
  test("a file that commits and then fails counts as a data change", () => {
    assert.strictEqual(
      hasIngestedChanges(emptyResult({ processed: 1, failed: 1 })),
      false,
      "A file that failed before writing anything changed nothing",
    );
    assert.strictEqual(
      hasIngestedChanges(emptyResult({ processed: 1, failed: 1, partialCommits: 1 })),
      true,
      "Rows committed before the failure are in the database and must be reported",
    );
  });
});

suite("Partial ingest reporting", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-partial-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStore(name: string) {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, name), SQL);
    await store.migrateOrRebuild();
    return store;
  }

  function bigCodexFile(name: string, turns: number): CandidateFile {
    const file = join(dir, name);
    const lines: string[] = [
      JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/repo", cli_version: "1.0.0" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }),
    ];
    let total = 0;
    for (let index = 0; index < turns; index++) {
      total += 100;
      lines.push(JSON.stringify({
        type: "event_msg",
        timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, index)).toISOString(),
        payload: {
          type: "token_count",
          info: {
            model_context_window: 272000,
            last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            total_token_usage: {
              input_tokens: total,
              cached_input_tokens: 0,
              output_tokens: total / 5,
              reasoning_output_tokens: 0,
              total_tokens: total + total / 5,
            },
          },
        },
      }));
    }
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const stat = statSync(file);
    return { filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "codex:1" };
  }

  test("ingestFile reports how much it committed before failing", async () => {
    const store = await openStore("partial.sqlite");
    const pricing = new PricingEngine({}, undefined);
    const candidate = bigCodexFile("codex.jsonl", 12_000);

    let checkpoints = 0;
    await assert.rejects(
      () => ingestFile(candidate, store, pricing, {
        maxLineBytes: 1_048_576,
        backfillMonths: 0,
        onCheckpoint: () => {
          checkpoints++;
          if (checkpoints === 1) { throw new Error("disk full"); }
        },
      }),
      (error: unknown) => {
        assert.ok(isPartialIngestError(error), String(error));
        assert.ok(error.committedBatches > 0);
        return true;
      },
    );
    assert.ok(store.usageRecordCount() > 0, "The committed batch is really in the database");
    store.close();
  });

  test("a scan with a partial commit is reported as a data change", async () => {
    const store = await openStore("scan.sqlite");
    const pricing = new PricingEngine({}, undefined);
    const candidate = bigCodexFile("codex.jsonl", 12_000);

    let checkpoints = 0;
    const result = await ingestAll(
      [candidate],
      store,
      pricing,
      {
        maxLineBytes: 1_048_576,
        backfillMonths: 0,
        onCheckpoint: () => {
          checkpoints++;
          if (checkpoints === 1) { throw new Error("disk full"); }
        },
      },
      undefined,
      new FileQuarantine(),
    );

    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.partialCommits, 1);
    assert.ok(
      hasIngestedChanges(result),
      "The scan wrote rows before failing, so the host must refresh and flush",
    );
    store.close();
  });

  test("a scan can be asked to stop between files", async () => {
    const store = await openStore("stop.sqlite");
    const pricing = new PricingEngine({}, undefined);

    const candidates: CandidateFile[] = [];
    for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
      const file = join(dir, name);
      writeFileSync(file, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");
      const stat = statSync(file);
      candidates.push({ filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: name });
    }

    let stop = false;
    const result = await ingestAll(candidates, store, pricing, {
      maxLineBytes: 1_048_576,
      backfillMonths: 0,
      shouldStop: () => stop,
      onCheckpoint: () => { stop = true; },
    });

    assert.strictEqual(result.stoppedEarly, true, "The scan should stop when asked");
    assert.ok(result.processed < candidates.length, "It should not finish every candidate");
    store.close();
  });
});

suite("Follower pricing", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-follower-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rebuilding aggregates is what makes a price change visible", async () => {
    // A follower window used to build a new PricingEngine and stop there, but
    // the dashboard reads pre-computed costs out of daily_aggregate — so it
    // kept showing the old price until the owner happened to rebuild.
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();

    const file = join(dir, "codex.jsonl");
    writeFileSync(file, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file,
      source: "codex",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: "codex:1",
    };

    const cheap = mergePricingConfig({ "gpt-5-codex": { inputPer1K: 1, outputPer1K: 1 } });
    const cheapEngine = new PricingEngine(cheap.table, cheap.fallbackRate);
    await ingestFile(candidate, store, cheapEngine, { maxLineBytes: 1_048_576, backfillMonths: 0 });

    const query = { view: "series", granularity: "day", range: { fromUtc: 0, toUtc: Date.now() } } as const;
    const before = dailySeries(store.database, query).reduce((sum, row) => sum + row.costUsd, 0);
    assert.ok(before > 0, "The fixture should cost something at the cheap rate");

    // Ten times the price, applied the way a follower now does it.
    const dear = mergePricingConfig({ "gpt-5-codex": { inputPer1K: 10, outputPer1K: 10 } });
    const dearEngine = new PricingEngine(dear.table, dear.fallbackRate);
    rebuildAggregates(store.database, dearEngine);

    const after = dailySeries(store.database, query).reduce((sum, row) => sum + row.costUsd, 0);
    assert.ok(
      Math.abs(after - before * 10) < before * 0.001,
      `A 10x price change should show as a 10x cost: ${before} -> ${after}`,
    );
    store.close();
  });
});

suite("Reset durability", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-reset-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a cleared database is persisted immediately, not left in memory", async () => {
    const SQL = await initSqlJs();
    const dbPath = join(dir, "db.sqlite");
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();

    const file = join(dir, "codex.jsonl");
    writeFileSync(file, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");
    const stat = statSync(file);
    await ingestFile(
      { filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "codex:1" },
      store,
      new PricingEngine({}, undefined),
      { maxLineBytes: 1_048_576, backfillMonths: 0 },
    );
    store.flush();
    assert.ok(store.usageRecordCount() > 0);

    // What handleResetDatabase does: clear, then force the snapshot out. A
    // throttled flush here left the deleted rows on disk, and a crash before
    // the next real write brought all of them back.
    store.resetDatabase();
    assert.strictEqual(store.flush({ force: true }), true, "The cleared database must reach disk");

    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    assert.strictEqual(reopened.usageRecordCount(), 0, "The reset must survive a restart");
    reopened.close();
    store.close();
  });

  test("a reset that only clears memory is lost on restart", async () => {
    // The failure this guards against, stated as the property it violates.
    const SQL = await initSqlJs();
    const dbPath = join(dir, "db2.sqlite");
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    store.setMeta("marker", "before-reset");
    store.flush();

    store.resetDatabase();
    // Deliberately NOT flushed.

    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    assert.strictEqual(
      reopened.getMeta("marker"),
      "before-reset",
      "Without a forced flush the old snapshot is still what a restart reads",
    );
    reopened.close();
    store.close();
  });

  test("every database generation is quarantined, so none can be copied back", () => {
    // handleInit copies v7/legacy into v8 when v8 is absent. Quarantining only
    // v8 therefore restored the data the reset had just removed.
    const v8 = join(dir, "token-watch-v8.db");
    const v7 = join(dir, "token-watch-v7.db");
    const legacy = join(dir, "token-watch.db");
    for (const path of [v8, v7, legacy]) {
      writeFileSync(path, "database bytes", "utf8");
    }

    for (const path of [v8, v7, legacy]) {
      quarantine(path);
    }

    for (const path of [v8, v7, legacy]) {
      assert.strictEqual(existsSync(path), false, `${path} must be moved aside by a reset`);
    }
  });
});

/** Mirrors the worker's quarantineDatabaseFile, which is module-private. */
function quarantine(dbPath: string): void {
  if (!existsSync(dbPath)) { return; }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
}
