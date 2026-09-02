import * as assert from "node:assert";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import initSqlJs from "sql.js";

import { ConcurrentUsageStoreWriteError, UsageStore } from "../../worker/store/UsageStore.js";
import {
  MAX_READABLE_SCHEMA,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from "../../worker/store/schema.js";

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
      // A literal on purpose: this is the number an already-shipped build
      // wrote into the file, and it does not move when ours does.
      assert.strictEqual(store.getCursor("/non-empty.jsonl")?.parseRevision, 1);
      store.flush();
      assert.strictEqual(existsSync(`${path}.tmp`), false);
      assert.deepStrictEqual(
        readdirSync(tmpdir()).filter((name) => name.startsWith(`${basename(path)}.`) && name.endsWith(".tmp")),
        [],
      );
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
    // One past everything this build knows how to read. SCHEMA_VERSION + 1 is
    // no longer the right number: that is the version a pruned database wears,
    // and this build is the one that writes it.
    db.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
      [String(MAX_READABLE_SCHEMA + 1)],
    );
    const store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;
    await assert.rejects(() => store.migrateOrRebuild(), /newer than supported/);
    assert.ok(db.exec("SELECT name FROM sqlite_master WHERE name = 'usage_record'").length > 0);
    store.close();
  });

  test("refuses to overwrite a snapshot changed by another store", async () => {
    const SQL = await initSqlJs();
    const path = join(tmpdir(), `token-watch-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const seed = new UsageStore();
    const first = new UsageStore();
    const second = new UsageStore();
    const verify = new UsageStore();
    try {
      await seed.open(path, SQL);
      await seed.migrateOrRebuild();
      seed.flush();
      seed.close();

      await first.open(path, SQL);
      await second.open(path, SQL);
      first.setMeta("writer:first", "kept");
      first.flush();
      second.setMeta("writer:second", "must-not-overwrite");

      assert.throws(() => second.flush(), ConcurrentUsageStoreWriteError);

      // flush() is a no-op on a clean store, so dirty it before each attempt
      // that is expected to reach the write lock and fail.
      writeFileSync(`${path}.lock`, `${process.pid}:other-worker`);
      first.setMeta("writer:first:attempt", "live-lock");
      assert.throws(() => first.flush(), ConcurrentUsageStoreWriteError);
      assert.strictEqual(existsSync(`${path}.lock`), true);
      unlinkSync(`${path}.lock`);

      writeFileSync(`${path}.lock`, "");
      first.setMeta("writer:first:attempt", "empty-lock");
      assert.throws(() => first.flush(), ConcurrentUsageStoreWriteError);
      unlinkSync(`${path}.lock`);

      await verify.open(path, SQL);
      assert.strictEqual(verify.getMeta("writer:first"), "kept");
      assert.strictEqual(verify.getMeta("writer:second"), undefined);

      second.reload();
      assert.strictEqual(second.getMeta("writer:first"), "kept");
      second.setMeta("writer:second", "after-reload");
      second.flush();
      verify.reload();
      assert.strictEqual(verify.getMeta("writer:second"), "after-reload");
    } finally {
      seed.close();
      first.close();
      second.close();
      verify.close();
      try { unlinkSync(path); } catch { /* ignore */ }
      try { unlinkSync(`${path}.lock`); } catch { /* ignore */ }
    }
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
      // Pinned to the constant, not a literal: a v7 database has to arrive at
      // whatever the current schema is, not at the version that happened to be
      // current when this test was written.
      assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);
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

suite("Upgrading an existing database keeps every number", () => {
  /** A database exactly as a previously shipped build would have left it. */
  async function seedShipped(SQL: initSqlJs.SqlJsStatic, path: string): Promise<void> {
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    // The two indexes that build created and this one no longer wants.
    db.run("CREATE INDEX IF NOT EXISTS idx_rec_session ON usage_record(source, session_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_rec_day ON usage_record(day_local)");
    // Pinned to 8, not SCHEMA_VERSION: this is standing in for a database an
    // already-shipped build left behind, which does not move when ours does.
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')");
    for (let i = 0; i < 50; i++) {
      db.run(
        `INSERT INTO usage_record
         (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
          model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens)
         VALUES (?, 'f1', 'claude', ?, ?, ?, 1, 10, 'claude-opus-5', 'high', 'claude-opus-5 (high)', '', ?, ?, ?)`,
        [`k${i}`, `s${i % 5}`, 1785000000000 + i * 1000, `2026-08-0${1 + (i % 9)}`, i, i * 2, i * 3],
      );
    }
    writeFileSync(path, db.export());
    db.close();
  }

  function indexNames(store: UsageStore): string[] {
    const rows = store.database.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_record'",
    );
    return rows.length === 0 ? [] : rows[0].values.map((r) => String(r[0]));
  }

  function tmpPath(tag: string): string {
    return join(tmpdir(), `tw-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  test("the redundant indexes go, and no number moves", async () => {
    // Dropping an index is not a schema change: nothing names an index, SQLite
    // chooses them, and no build depends on one existing. It is applied as
    // maintenance on every open rather than as a migration.
    const SQL = await initSqlJs();
    const path = tmpPath("compat");
    await seedShipped(SQL, path);
    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      const before = store.database.exec(
        "SELECT COUNT(*), SUM(total_tokens) FROM usage_record",
      )[0].values[0];
      assert.ok(indexNames(store).includes("idx_rec_session"), "the seed must really carry them");

      assert.strictEqual(await store.migrateOrRebuild(), "migrated");
      assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);

      const after = indexNames(store);
      assert.ok(!after.includes("idx_rec_session"), "idx_rec_session must be gone");
      assert.ok(!after.includes("idx_rec_day"), "idx_rec_day must be gone");
      assert.ok(after.includes("idx_rec_session_model"), "the wider session index is load-bearing");
      assert.ok(after.includes("idx_rec_daily_key"), "the wider day index is load-bearing");
      assert.ok(after.includes("idx_rec_ts"));
      assert.ok(after.includes("idx_rec_file"));

      assert.deepStrictEqual(
        store.database.exec("SELECT COUNT(*), SUM(total_tokens) FROM usage_record")[0].values[0],
        before,
        "dropping an index must not move a single number",
      );
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  });

  test("dropping them twice is a no-op, not an error", async () => {
    // It runs on every open, so it has to be safe when there is nothing to do.
    const SQL = await initSqlJs();
    const path = tmpPath("idempotent");
    await seedShipped(SQL, path);
    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      await store.migrateOrRebuild();
      store.flush({ force: true });
      const first = store.database.export().length;

      const again = new UsageStore();
      await again.open(path, SQL);
      assert.strictEqual(await again.migrateOrRebuild(), "ok", "already at the current schema");
      assert.strictEqual(again.schemaVersion(), SCHEMA_VERSION);
      // Nothing left to drop means nothing to compact, so the file is untouched.
      assert.strictEqual(again.database.export().length, first);
      again.close();
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  });

  test("the lookups they served still use an index, not a table scan", async () => {
    const SQL = await initSqlJs();
    const path = tmpPath("plan");
    await seedShipped(SQL, path);
    const store = new UsageStore();
    try {
      await store.open(path, SQL);
      await store.migrateOrRebuild();
      const plan = (sql: string): string => store.database
        .exec(`EXPLAIN QUERY PLAN ${sql}`)[0].values.map((r) => String(r[3])).join(" | ");

      const bySession = plan(
        "SELECT SUM(total_tokens) FROM usage_record WHERE source = 'claude' AND session_id = 's1'",
      );
      assert.match(bySession, /SEARCH/, `session lookup must still SEARCH: ${bySession}`);
      assert.match(bySession, /idx_rec_session_model/, bySession);

      const byDay = plan("SELECT SUM(total_tokens) FROM usage_record WHERE day_local = '2026-08-03'");
      assert.match(byDay, /SEARCH/, `day lookup must still SEARCH: ${byDay}`);
      assert.match(byDay, /idx_rec_daily_key/, byDay);
    } finally {
      store.close();
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  });
});
