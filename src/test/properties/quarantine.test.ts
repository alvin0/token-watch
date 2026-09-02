import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { FileQuarantine } from "../../worker/quarantine.js";
import { ingestAll } from "../../worker/ingest.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import type { CandidateFile } from "../../worker/discovery.js";
import { CODEX_ROLLOUT_JSONL } from "../fixtures/codexRollout.js";

suite("File quarantine", () => {
  test("backs off further after each failure and clears on success", () => {
    let now = 1_000_000;
    const quarantine = new FileQuarantine();

    assert.strictEqual(quarantine.shouldSkip("/a.jsonl", now), false);

    const first = quarantine.recordFailure("/a.jsonl", new Error("EACCES: denied"), now);
    assert.strictEqual(first.failures, 1);
    assert.ok(quarantine.shouldSkip("/a.jsonl", now));
    assert.ok(!quarantine.shouldSkip("/a.jsonl", first.retryAtMs + 1));

    now = first.retryAtMs + 1;
    const second = quarantine.recordFailure("/a.jsonl", new Error("EACCES: denied"), now);
    assert.strictEqual(second.failures, 2);
    assert.ok(
      second.retryAtMs - now > first.retryAtMs - 1_000_000,
      "The second backoff must be longer than the first",
    );

    quarantine.recordSuccess("/a.jsonl");
    assert.strictEqual(quarantine.shouldSkip("/a.jsonl", now), false);
    assert.strictEqual(quarantine.size, 0);
  });

  test("keeps the error code in the snapshot", () => {
    const quarantine = new FileQuarantine();
    const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
    quarantine.recordFailure("/gone.jsonl", error, 0);
    assert.ok(quarantine.snapshot()[0].lastError.startsWith("ENOENT:"));
  });

  test("clear() drops every backoff", () => {
    const quarantine = new FileQuarantine();
    quarantine.recordFailure("/a.jsonl", new Error("boom"), 0);
    quarantine.recordFailure("/b.jsonl", new Error("boom"), 0);
    quarantine.clear();
    assert.strictEqual(quarantine.size, 0);
  });
});

suite("Ingestion failure isolation", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-isolation-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("one unreadable file does not stop the files ranked behind it", async () => {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();
    const pricing = new PricingEngine({}, undefined);

    // A file that exists for discovery but is removed before it is read.
    const missing = join(dir, "missing.jsonl");
    const good = join(dir, "good.jsonl");
    writeFileSync(good, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");

    const candidates: CandidateFile[] = [
      { filePath: missing, source: "codex", size: 10, mtimeMs: Date.now(), fileId: "missing:1" },
      { filePath: good, source: "codex", size: statSync(good).size, mtimeMs: statSync(good).mtimeMs, fileId: "good:1" },
    ];

    const quarantine = new FileQuarantine();
    const failures: string[] = [];
    const result = await ingestAll(
      candidates,
      store,
      pricing,
      { maxLineBytes: 1_048_576, backfillMonths: 0 },
      undefined,
      quarantine,
      (candidate) => failures.push(candidate.filePath),
    );

    assert.strictEqual(result.failed, 1, "The unreadable file should be counted as failed");
    assert.deepStrictEqual(failures, [missing]);
    assert.strictEqual(result.processed, 2, "Both candidates should be accounted for");
    assert.ok(quarantine.shouldSkip(missing), "The failing file should be quarantined");
    assert.strictEqual(quarantine.shouldSkip(good), false);

    // The healthy file behind it really was ingested.
    assert.ok(store.usageRecordCount() > 0, "The readable file must still be ingested");
    store.close();
  });

  test("a quarantined file is skipped without being retried", async () => {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, "db2.sqlite"), SQL);
    await store.migrateOrRebuild();
    const pricing = new PricingEngine({}, undefined);

    const missing = join(dir, "still-missing.jsonl");
    const candidates: CandidateFile[] = [
      { filePath: missing, source: "codex", size: 10, mtimeMs: Date.now(), fileId: "missing:1" },
    ];
    const quarantine = new FileQuarantine();

    const options = { maxLineBytes: 1_048_576, backfillMonths: 0 };
    await ingestAll(candidates, store, pricing, options, undefined, quarantine);

    let retried = 0;
    const second = await ingestAll(candidates, store, pricing, options, undefined, quarantine, () => { retried++; });

    assert.strictEqual(second.quarantined, 1);
    assert.strictEqual(retried, 0, "A file inside its backoff window must not be read again");
    store.close();
  });
});

