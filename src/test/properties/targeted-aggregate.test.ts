import * as assert from "node:assert";
import { CODEX_PARSE_REVISION } from "../../worker/parsers/revision.js";
import initSqlJs, { type Database } from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { aggregateIntegrity, rebuildAggregates } from "../../worker/store/queries.js";
import { PricingEngine } from "../../worker/pricing.js";
import type { FileCursor, StoreBatch } from "../../shared/storeTypes.js";
import type { UsageRecord } from "../../shared/types.js";

suite("Targeted aggregate accounting", () => {
  test("matches canonical rebuild across multi-file long-context crossing up and down", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    const store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;
    const pricing = new PricingEngine({
      "gpt-5.5": { inputPer1K: 0.005, outputPer1K: 0.03 },
      "gpt-5.5-long-context": { inputPer1K: 0.01, outputPer1K: 0.045 },
    });
    const low = record("low", "2026-07-09T10:00:00Z", 100_000);
    const high = record("high", "2026-07-10T10:00:00Z", 300_000);

    store.commitFileResult("file-low", batch([low]), "firstRead", pricing, cursor("file-low", low));
    assertApprox(singleNumber(db, "SELECT cost_usd FROM session_aggregate"), 0.035);

    store.commitFileResult("file-high", batch([high]), "firstRead", pricing, cursor("file-high", high));
    assertApprox(singleNumber(db, "SELECT cost_usd FROM session_aggregate"), 0.11);
    assert.strictEqual(aggregateIntegrity(db).valid, true);
    assertCanonicalStable(db, pricing);

    store.commitFileResult(
      "file-high",
      batch([]),
      "reingest",
      pricing,
      emptyCursor("file-high"),
      "file-high",
    );
    assertApprox(singleNumber(db, "SELECT cost_usd FROM session_aggregate"), 0.035);
    assert.strictEqual(singleNumber(db, "SELECT COUNT(*) FROM daily_aggregate"), 1);
    assert.strictEqual(aggregateIntegrity(db).valid, true);
    assertCanonicalStable(db, pricing);
    store.close();
  });

  test("tracks fallback-priced records as unknown in targeted aggregates", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    const store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;
    const pricing = new PricingEngine({});
    const unknown = { ...record("unknown", "2026-07-10T11:00:00Z", 100), model: "future-model", variantId: "future-model" };
    store.commitFileResult("unknown-file", batch([unknown]), "firstRead", pricing, cursor("unknown-file", unknown));

    assert.strictEqual(singleNumber(db, "SELECT cost_unknown FROM usage_record"), 1);
    assert.strictEqual(singleNumber(db, "SELECT unknown_cost_turns FROM daily_aggregate"), 1);
    assert.strictEqual(aggregateIntegrity(db).valid, true);
    assertCanonicalStable(db, pricing);
    store.close();
  });

  test("matches canonical session workspace selection across multiple models", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    const store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;
    const pricing = new PricingEngine({});
    const first = { ...record("model-a", "2026-07-10T10:00:00Z", 100), workspace: "/a" };
    const second = {
      ...record("model-z", "2026-07-10T11:00:00Z", 100),
      model: "another-model", variantId: "another-model", workspace: "/z",
    };
    store.commitFileResult("model-a-file", batch([first]), "firstRead", pricing, cursor("model-a-file", first));
    store.commitFileResult("model-z-file", batch([second]), "firstRead", pricing, cursor("model-z-file", second));

    assert.strictEqual(db.exec("SELECT workspace FROM session_aggregate")[0].values[0][0], "/z");
    assertCanonicalStable(db, pricing);
    store.close();
  });
});

function record(id: string, timestamp: string, contextUsedTokens: number): UsageRecord {
  return {
    source: "codex",
    sessionId: "shared-session",
    dedupKey: `codex:shared-session:${id}`,
    timestamp: new Date(timestamp).getTime(),
    model: "gpt-5.5",
    variantId: "gpt-5.5",
    workspace: "/workspace",
    inputTokens: 1000,
    outputTokens: 1000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    meta: { contextUsedTokens },
  };
}

function batch(records: UsageRecord[]): StoreBatch {
  return {
    records,
    toolEvents: [],
    contribution: { daily: [], sessions: [], recordKeys: records.map((item) => item.dedupKey), toolEventCount: 0 },
  };
}

function cursor(fileId: string, item: UsageRecord): FileCursor {
  return {
    filePath: `/${fileId}.jsonl`, fileId, source: item.source,
    size: 1, mtimeMs: 1, lastByteOffset: 1, headHash: "h", tailAnchorHash: "t",
    runningTotals: {}, recentRequestIds: [], parseRevision: CODEX_PARSE_REVISION,
    contribution: batch([item]).contribution,
  };
}

function emptyCursor(fileId: string): FileCursor {
  return {
    filePath: `/${fileId}.jsonl`, fileId, source: "codex",
    size: 0, mtimeMs: 2, lastByteOffset: 0, headHash: "h", tailAnchorHash: "t",
    runningTotals: {}, recentRequestIds: [], parseRevision: CODEX_PARSE_REVISION,
    contribution: batch([]).contribution,
  };
}

function assertCanonicalStable(db: Database, pricing: PricingEngine): void {
  const before = aggregateRows(db);
  rebuildAggregates(db, pricing);
  assert.deepStrictEqual(aggregateRows(db), before);
}

function aggregateRows(db: Database): unknown {
  return {
    daily: db.exec("SELECT * FROM daily_aggregate ORDER BY day_local, source, variant_id, workspace")[0]?.values ?? [],
    sessions: db.exec("SELECT * FROM session_aggregate ORDER BY source, session_id")[0]?.values ?? [],
  };
}

function singleNumber(db: Database, sql: string): number {
  return Number(db.exec(sql)[0].values[0][0]);
}

function assertApprox(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`);
}
