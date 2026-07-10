import * as assert from "node:assert";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";

suite("Schema v7 migration", () => {
  test("migrates a v6 copy additively and preserves legacy empty cursors for one repair", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const v6Schema = SCHEMA_SQL.replace(
      ",\n  parse_revision   INTEGER NOT NULL DEFAULT 0",
      "",
    );
    db.exec(v6Schema);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')");
    const empty = JSON.stringify({ daily: [], sessions: [], recordKeys: [], toolEventCount: 0 });
    const nonEmpty = JSON.stringify({
      daily: [{
        day: "2026-07-10", source: "codex", variantId: "gpt-5", workspace: "",
        sums: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
        turns: 1, costUsd: 0, unknownTurns: 0,
      }],
      sessions: [], recordKeys: ["record"], toolEventCount: 0,
    });
    const insert = db.prepare(
      `INSERT INTO file_cursor
       (file_path, file_id, source, size, mtime_ms, last_byte_offset, head_hash,
        tail_anchor_hash, running_totals, recent_req_ids, contribution)
       VALUES (?, ?, 'codex', 1, 1, 1, 'h', 't', '{}', '[]', ?)`,
    );
    insert.run(["/empty.jsonl", "empty", empty]);
    insert.run(["/non-empty.jsonl", "non-empty", nonEmpty]);
    insert.free();

    const path = join(tmpdir(), `token-watch-v6-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    writeFileSync(path, db.export());
    db.close();

    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      assert.strictEqual(await store.migrateOrRebuild(7), "migrated");
      assert.strictEqual(store.schemaVersion(), 7);
      assert.strictEqual(store.getCursor("/empty.jsonl")?.parseRevision, 0);
      assert.strictEqual(store.getCursor("/non-empty.jsonl")?.parseRevision, 1);
      store.flush();
      assert.strictEqual(existsSync(`${path}.tmp`), false);
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
      try { unlinkSync(`${path}.tmp`); } catch { /* ignore */ }
    }
  });

  test("refuses a future schema instead of dropping it", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION + 1)]);
    const store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;
    await assert.rejects(() => store.migrateOrRebuild(), /newer than supported/);
    assert.ok(db.exec("SELECT name FROM sqlite_master WHERE name = 'usage_record'").length > 0);
    store.close();
  });

  test("migrates v7 to v8 without changing usage token data", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')");
    db.run("ALTER TABLE usage_record RENAME TO usage_record_v8");
    db.run(
      `CREATE TABLE usage_record AS
       SELECT dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
              model, effort, variant_id, workspace, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
              context_window, context_used_tokens, is_sidechain, stop_reason
       FROM usage_record_v8 WHERE 0`,
    );
    db.run("DROP TABLE usage_record_v8");
    const path = join(tmpdir(), `token-watch-v7-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    writeFileSync(path, db.export());
    db.close();
    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      assert.strictEqual(await store.migrateOrRebuild(), "migrated");
      assert.strictEqual(store.schemaVersion(), 8);
      const columns = store.database.exec("PRAGMA table_info(usage_record)")[0].values.map((row) => row[1]);
      assert.ok(columns.includes("cost_usd"));
      assert.ok(columns.includes("cost_unknown"));
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  });

  test("reload restores the last atomic snapshot after unflushed mutations", async () => {
    const SQL = await initSqlJs();
    const path = join(tmpdir(), `token-watch-reload-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      await store.migrateOrRebuild();
      store.setMeta("snapshot", "clean");
      store.flush();
      store.setMeta("snapshot", "dirty");
      store.reload();
      assert.strictEqual(store.getMeta("snapshot"), "clean");
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
      try { unlinkSync(`${path}.tmp`); } catch { /* ignore */ }
    }
  });
});
