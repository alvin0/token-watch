import * as assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { isWriterFenceLostError, UsageStore } from "../../worker/store/UsageStore.js";

suite("Store flush amplification", () => {
  let dir: string;
  let dbPath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-flush-"));
    dbPath = join(dir, "usage.db");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStore() {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    return store;
  }

  test("an unchanged database is not rewritten", async () => {
    const store = await openStore();
    assert.strictEqual(store.flush(), true, "The first flush must create the file");

    const before = statSync(dbPath);
    assert.strictEqual(store.isDirty(), false, "A just-flushed store is clean");
    assert.strictEqual(store.flush(), false, "A clean store must not re-export the database");
    assert.strictEqual(statSync(dbPath).mtimeMs, before.mtimeMs, "The file must not be touched");
    store.close();
  });

  test("a write marks the store dirty and the next flush persists it", async () => {
    const store = await openStore();
    store.flush();

    store.setMeta("watch_tick", "1");
    assert.strictEqual(store.isDirty(), true);
    assert.strictEqual(store.flush(), true);
    assert.strictEqual(store.isDirty(), false);
    store.close();
  });

  test("force writes even when nothing changed", async () => {
    const store = await openStore();
    store.flush();
    assert.strictEqual(store.flush({ force: true }), true);
    store.close();
  });

  test("flushIfDue throttles bookkeeping-only writes", async () => {
    const store = await openStore();
    store.flush();

    const interval = 5 * 60_000;
    const now = Date.now();

    store.setMeta("last_seen", "1");
    assert.strictEqual(store.flushIfDue(interval, now), false, "Too soon after the last flush");
    assert.strictEqual(store.isDirty(), true, "The change is still pending, not lost");

    assert.strictEqual(store.flushIfDue(interval, now + interval + 1), true, "Past the interval it writes");
    assert.strictEqual(store.isDirty(), false);
    store.close();
  });

  test("a truncating reset still counts as dirty", async () => {
    const store = await openStore();
    store.setMeta("seed", "1");
    store.flush();

    // Bare DELETEs can take SQLite's truncate path, which does not move
    // total_changes(); the store flags them explicitly.
    store.clearIngestedData();
    assert.strictEqual(store.isDirty(), true, "A truncation must not look like a no-op");
    store.close();
  });

  test("reopening a persisted database starts clean", async () => {
    const first = await openStore();
    first.setMeta("value", "1");
    first.flush();
    first.close();

    const SQL = await initSqlJs();
    const second = new UsageStore();
    await second.open(dbPath, SQL);
    assert.strictEqual(second.getMeta("value"), "1");
    // migrateOrRebuild ensures auxiliary schema, which is DDL and flagged dirty,
    // so check the state before it runs.
    assert.strictEqual(second.isDirty(), false, "Opening an up-to-date file changes nothing");
    second.close();
  });
});


suite("Store write fence", () => {
  let dir: string;
  let dbPath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-fence-store-"));
    dbPath = join(dir, "usage.db");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStore() {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    return store;
  }

  test("a worker that lost the lease cannot write, even mid-flush", async () => {
    const store = await openStore();
    let owner = true;
    // The fence is consulted inside the write lock, immediately before the
    // rename — not once before the scan, when it could still go stale.
    store.setWriteFence(() => owner);
    store.setMeta("first", "1");
    assert.strictEqual(store.flush(), true);

    owner = false;
    store.setMeta("second", "2");
    assert.throws(() => store.flush(), (error: unknown) => isWriterFenceLostError(error));

    const SQL = await initSqlJs();
    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    assert.strictEqual(reopened.getMeta("first"), "1");
    assert.strictEqual(reopened.getMeta("second"), undefined, "The refused write must not have landed");
    reopened.close();
    store.close();
  });

  test("a forced flush is fenced too", async () => {
    const store = await openStore();
    store.setWriteFence(() => false);
    assert.throws(() => store.flush({ force: true }), (error: unknown) => isWriterFenceLostError(error));
    store.close();
  });

  test("regaining the lease allows writing again", async () => {
    const store = await openStore();
    let owner = false;
    store.setWriteFence(() => owner);
    store.setMeta("value", "1");
    assert.throws(() => store.flush(), (error: unknown) => isWriterFenceLostError(error));

    owner = true;
    assert.strictEqual(store.flush(), true);
    const SQL = await initSqlJs();
    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    assert.strictEqual(reopened.getMeta("value"), "1");
    reopened.close();
    store.close();
  });

  test("no fence means no gate, for tests and migrations that own the file", async () => {
    const store = await openStore();
    store.setWriteFence(undefined);
    store.setMeta("value", "1");
    assert.strictEqual(store.flush(), true);
    store.close();
  });
});

suite("Abandoned snapshots are swept", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-sweep-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("opening the database removes temp snapshots earlier runs left behind", async () => {
    // A window closed mid-flush cannot clean up after itself, and each temp is
    // a full copy of the database. On a large install these reached gigabytes
    // that nothing would ever reclaim.
    const SQL = await initSqlJs();
    const dbPath = join(dir, "token-watch-v8.db");

    const old = `${dbPath}.4242.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`;
    const fresh = `${dbPath}.4243.aaaaaaaa-bbbb-cccc-dddd-ffffffffffff.tmp`;
    const unrelated = join(dir, "something-else.tmp");
    for (const p of [old, fresh, unrelated]) { writeFileSync(p, "snapshot bytes", "utf8"); }
    // Two hours old: past any plausible in-progress write.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    const store = new UsageStore();
    await store.open(dbPath, SQL);

    assert.strictEqual(existsSync(old), false, "an abandoned snapshot must be reclaimed");
    assert.strictEqual(existsSync(fresh), true, "a recent one may belong to a live writer");
    assert.strictEqual(existsSync(unrelated), true, "only this database's temps are ours to delete");
    store.close();
  });

  test("a flush that fails partway leaves no snapshot behind", async () => {
    const SQL = await initSqlJs();
    const dbPath = join(dir, "token-watch-v8.db");
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    store.setMeta("value", "1");

    // Only a failed rename used to be cleaned up, so a write or fsync that
    // threw left a full-size file on disk for good.
    const original = store.database.export.bind(store.database);
    (store.database as unknown as { export: () => Uint8Array }).export = () => {
      const data = original();
      // Fails inside writeFileSync, after the temp has been created.
      return new Proxy(data, { get(t, p) { if (p === "byteLength") { throw new Error("disk full"); } return Reflect.get(t, p); } });
    };

    try { store.flush({ force: true }); } catch { /* expected */ }

    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepStrictEqual(leftovers, [], `a failed flush left ${leftovers.join(", ")} behind`);
    store.close();
  });
});
