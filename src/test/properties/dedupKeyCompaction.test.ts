import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { storageKey } from "../../worker/store/dedupKey.js";
import { SCHEMA_VERSION } from "../../worker/store/schema.js";
import { PricingEngine } from "../../worker/pricing.js";
import { ingestFile } from "../../worker/ingest.js";
import { rebuildAggregates } from "../../worker/store/queries.js";
import type { CandidateFile } from "../../worker/discovery.js";
import { CODEX_ROLLOUT_JSONL } from "../fixtures/codexRollout.js";

suite("Dedup keys are stored compactly", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });
  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-dedup-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  async function openStore(name = "db.sqlite"): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, name), SQL);
    await store.migrateOrRebuild();
    return store;
  }

  function codexFixture(name = "codex.jsonl"): CandidateFile {
    const file = join(dir, name);
    writeFileSync(file, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");
    const stat = statSync(file);
    return { filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: `id:${name}` };
  }

  test("the stored form is short and stable", () => {
    const readable = "claude:14446be4-8c0b-48e8-8d67-2cae5edfd671:da71f6f87e1e1c8e:req_011CabcDEF:4096";
    const stored = storageKey(readable);
    assert.strictEqual(stored.length, 16, `expected 16 characters, got ${stored.length}`);
    assert.strictEqual(stored, storageKey(readable), "the same key must always hash the same");
    assert.notStrictEqual(stored, storageKey(`${readable}0`), "different keys must differ");
    // base64url only, so it never needs quoting or escaping anywhere.
    assert.match(stored, /^[A-Za-z0-9_-]{16}$/, stored);
  });

  test("ingestion writes short keys, and the tool events still join", async () => {
    const store = await openStore();
    await ingestFile(codexFixture(), store, new PricingEngine({}, undefined), {
      maxLineBytes: 1_048_576, backfillMonths: 0,
    });
    assert.ok(store.usageRecordCount() > 0, "the fixture should produce records");

    const longest = Number(store.database.exec(
      "SELECT MAX(LENGTH(dedup_key)) FROM usage_record",
    )[0].values[0][0]);
    assert.strictEqual(longest, 16, `no stored key may exceed 16 bytes, saw ${longest}`);

    const events = Number(store.database.exec("SELECT COUNT(*) FROM tool_event")[0].values[0][0]);
    const joined = Number(store.database.exec(
      "SELECT COUNT(*) FROM tool_event t JOIN usage_record r ON r.dedup_key = t.record_dedup_key",
    )[0].values[0][0]);
    assert.strictEqual(joined, events, "every tool event must still find its turn");
    if (events > 0) {
      const longestEvent = Number(store.database.exec(
        "SELECT MAX(LENGTH(event_key)) FROM tool_event",
      )[0].values[0][0]);
      assert.strictEqual(longestEvent, 16, "the event key is opaque too");
    }
    store.close();
  });

  test("re-reading the same file replaces turns instead of adding them", async () => {
    // The property the whole change rests on: a key computed after the switch
    // must land on the row it replaces. If it did not, every rescan would double
    // the totals.
    const store = await openStore();
    const pricing = new PricingEngine({}, undefined);
    const candidate = codexFixture();
    const opts = { maxLineBytes: 1_048_576, backfillMonths: 0 };

    await ingestFile(candidate, store, pricing, opts);
    const first = store.database.exec(
      "SELECT COUNT(*), SUM(total_tokens) FROM usage_record",
    )[0].values[0];

    // Drop the cursor and read the identical file again, which is what a rescan
    // amounts to: every key is recomputed from scratch and must land on the row
    // it already wrote.
    store.database.run("DELETE FROM file_cursor");
    store.markStructurallyDirty();
    await ingestFile(candidate, store, pricing, opts);
    const second = store.database.exec(
      "SELECT COUNT(*), SUM(total_tokens) FROM usage_record",
    )[0].values[0];

    assert.deepStrictEqual(second, first, "a re-read must not add a single row or token");
    store.close();
  });

  test("a database from before the change is migrated, and its numbers do not move", async () => {
    const path = join(dir, "legacy.db");
    const db = new SQL.Database();
    // A schema 8 database with readable keys, exactly as an earlier build left it.
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE usage_record (
        dedup_key TEXT PRIMARY KEY, file_id TEXT NOT NULL, source TEXT NOT NULL,
        session_id TEXT NOT NULL, ts_utc INTEGER NOT NULL, day_local TEXT NOT NULL,
        dow_local INTEGER NOT NULL, hour_local INTEGER NOT NULL, model TEXT NOT NULL,
        effort TEXT NOT NULL, variant_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER, context_used_tokens INTEGER,
        is_sidechain INTEGER NOT NULL DEFAULT 0, stop_reason TEXT,
        cost_usd REAL NOT NULL DEFAULT 0, cost_unknown INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tool_event (
        event_key TEXT PRIMARY KEY, record_dedup_key TEXT NOT NULL, file_id TEXT NOT NULL,
        source TEXT NOT NULL, session_id TEXT NOT NULL, ts_utc INTEGER NOT NULL,
        day_local TEXT NOT NULL, tool_name TEXT NOT NULL, model TEXT NOT NULL,
        variant_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
        is_sidechain INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE daily_aggregate (
        day_local TEXT NOT NULL, source TEXT NOT NULL, variant_id TEXT NOT NULL,
        base_model TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        unknown_cost_turns INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day_local, source, variant_id, workspace)
      );
      CREATE TABLE session_aggregate (
        source TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
        first_ts_utc INTEGER NOT NULL, last_ts_utc INTEGER NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, sidechain_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, session_id)
      );
      CREATE TABLE file_cursor (
        file_path TEXT PRIMARY KEY, file_id TEXT NOT NULL, source TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, last_byte_offset INTEGER NOT NULL,
        head_hash TEXT NOT NULL, tail_anchor_hash TEXT NOT NULL, running_totals TEXT NOT NULL,
        recent_req_ids TEXT NOT NULL, contribution TEXT NOT NULL,
        parse_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE pricing (model TEXT PRIMARY KEY, input_per_1k REAL, output_per_1k REAL);
      CREATE TABLE unmapped_model (model TEXT PRIMARY KEY, seen_utc INTEGER);
      CREATE INDEX idx_rec_ts ON usage_record(ts_utc);
      CREATE INDEX idx_rec_session_model ON usage_record(source, session_id, model);
      CREATE INDEX idx_rec_daily_key ON usage_record(day_local, source, variant_id, workspace);
      CREATE INDEX idx_tool_record ON tool_event(record_dedup_key);
    `);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '8')");

    const readableKeys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const key = `claude:14446be4-8c0b-48e8-8d67-2cae5edfd671:da71f6f87e1e1c8e:req_${i}:${i * 1024}`;
      readableKeys.push(key);
      db.run(
        `INSERT INTO usage_record
         (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
          model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens)
         VALUES (?, 'f1', 'claude', 'sess', ?, '2026-08-10', 1, 9, 'claude-opus-5', 'high',
                 'claude-opus-5 (high)', '', 10, 5, 15)`,
        [key, 1785000000000 + i * 1000],
      );
      db.run(
        `INSERT INTO tool_event
         (event_key, record_dedup_key, file_id, source, session_id, ts_utc, day_local,
          tool_name, model, variant_id, workspace)
         VALUES (?, ?, 'f1', 'claude', 'sess', ?, '2026-08-10', 'Read', 'claude-opus-5',
                 'claude-opus-5 (high)', '')`,
        [`${key}#0`, key, 1785000000000 + i * 1000],
      );
    }
    db.run(
      `INSERT INTO file_cursor
       (file_path, file_id, source, size, mtime_ms, last_byte_offset, head_hash,
        tail_anchor_hash, running_totals, recent_req_ids, contribution, parse_revision)
       VALUES ('/logs/a.jsonl', 'f1', 'claude', 1, 1, 1, 'h', 't', '{}', '[]', ?, 0)`,
      [JSON.stringify({
        daily: [], sessions: [], recordKeys: readableKeys, toolEventCount: 30,
      })],
    );
    writeFileSync(path, db.export());
    db.close();

    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      assert.strictEqual(store.schemaVersion(), 8, "the seed must really be a version 8 database");
      assert.strictEqual(await store.migrateOrRebuild(), "migrated");
      assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);

      assert.strictEqual(store.usageRecordCount(), 30, "no record may be lost");
      assert.strictEqual(
        Number(store.database.exec("SELECT SUM(total_tokens) FROM usage_record")[0].values[0][0]),
        30 * 15,
        "and no token may move",
      );
      assert.strictEqual(
        Number(store.database.exec("SELECT MAX(LENGTH(dedup_key)) FROM usage_record")[0].values[0][0]),
        16,
      );
      assert.strictEqual(
        Number(store.database.exec(
          "SELECT COUNT(*) FROM tool_event t JOIN usage_record r ON r.dedup_key = t.record_dedup_key",
        )[0].values[0][0]),
        30,
        "every tool event must still join after the rewrite",
      );

      // Each migrated key must be exactly what the write path would produce, or
      // the next ingest of the same turn would insert a duplicate instead of
      // replacing it.
      const stored = new Set(store.database.exec("SELECT dedup_key FROM usage_record")[0]
        .values.map((row) => String(row[0])));
      for (const readable of readableKeys) {
        assert.ok(
          stored.has(storageKey(readable)),
          `migrated key for ${readable} does not match what ingestion would write`,
        );
      }

      // The cursor's list has to move with them, or an overlapping re-read stops
      // being recognised.
      const contribution = JSON.parse(String(store.database.exec(
        "SELECT contribution FROM file_cursor",
      )[0].values[0][0])) as { recordKeys: string[] };
      assert.deepStrictEqual(
        contribution.recordKeys,
        readableKeys.map((key) => storageKey(key)),
        "the cursor's record keys must be rewritten too",
      );
    } finally {
      store.close();
    }
  });

  test("an upgrade rewrites the file once, not once per step", async () => {
    // The migration rewrites every primary key and the maintenance step drops
    // two indexes; both leave holes only a full rewrite gives back. Doing that
    // rewrite twice cost the better part of a second on a large database for no
    // gain, so the need is recorded and acted on once at the end.
    const store = await openStore("once.sqlite");
    assert.strictEqual(
      store.compactIfPending(),
      false,
      "migrateOrRebuild must have already consumed any pending compaction",
    );
    store.close();
  });

  test("the migrated database still aggregates to the same numbers", async () => {
    const store = await openStore("agg.sqlite");
    const pricing = new PricingEngine({}, undefined);
    await ingestFile(codexFixture(), store, pricing, { maxLineBytes: 1_048_576, backfillMonths: 0 });
    const before = store.database.exec(
      "SELECT SUM(total_tokens), ROUND(SUM(cost_usd), 6) FROM daily_aggregate",
    )[0].values[0];

    rebuildAggregates(store.database, pricing);
    const after = store.database.exec(
      "SELECT SUM(total_tokens), ROUND(SUM(cost_usd), 6) FROM daily_aggregate",
    )[0].values[0];
    assert.deepStrictEqual(after, before, "compact keys must not disturb the aggregates");
    store.close();
  });
});
