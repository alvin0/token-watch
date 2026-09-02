import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { PRUNED_SCHEMA_VERSION, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { PricingEngine } from "../../worker/pricing.js";
import { aggregateIntegrity, dailySeries, rebuildAggregates } from "../../worker/store/queries.js";
import { ingestFile } from "../../worker/ingest.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { AnalyticsQuery } from "../../shared/protocol.js";
import { localDayFromMs, parseLocalDay } from "../../shared/time.js";
import { CODEX_ROLLOUT_JSONL } from "../fixtures/codexRollout.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 31, 12, 0, 0).getTime();

const ALL: AnalyticsQuery = {
  view: "series",
  granularity: "day",
  range: { fromUtc: 0, toUtc: NOW + DAY_MS },
} as AnalyticsQuery;

/**
 * One turn per session per day, so day and session boundaries line up and a
 * prune has an unambiguous correct answer.
 */
function seedDays(store: UsageStore, dayOffsets: number[], opts: { sessionPerDay?: boolean } = {}): void {
  const db = store.database;
  for (const offset of dayOffsets) {
    const ts = NOW - offset * DAY_MS;
    const day = localDayFromMs(ts);
    const session = opts.sessionPerDay === false ? "shared" : `s-${day}`;
    db.run(
      `INSERT INTO usage_record
       (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
        model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES (?, 'f1', 'codex', ?, ?, ?, 1, 10, 'gpt-5-codex', 'medium', 'gpt-5-codex (medium)', '', 10, 5, 15, 0.5)`,
      [`k-${offset}`, session, ts, day],
    );
    db.run(
      `INSERT INTO tool_event
       (event_key, record_dedup_key, file_id, source, session_id, ts_utc, day_local,
        tool_name, model, variant_id, workspace)
       VALUES (?, ?, 'f1', 'codex', ?, ?, ?, 'Read', 'gpt-5-codex', 'gpt-5-codex (medium)', '')`,
      [`e-${offset}`, `k-${offset}`, session, ts, day],
    );
  }
  store.markStructurallyDirty();
}

function totalsByDay(store: UsageStore): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of dailySeries(store.database, ALL)) {
    out.set(row.day, (out.get(row.day) ?? 0) + row.totalTokens);
  }
  return out;
}

suite("Retention prunes raw rows without losing history", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });

  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-retention-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  async function openStore(name = "db.sqlite"): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, name), SQL);
    await store.migrateOrRebuild();
    return store;
  }

  test("daily totals survive the loss of the rows they came from", async () => {
    const store = await openStore();
    seedDays(store, [100, 60, 30, 10, 1]);
    rebuildAggregates(store.database, new PricingEngine({}, undefined));
    const before = totalsByDay(store);
    assert.strictEqual(before.size, 5, "the seed must produce five distinct days");

    const outcome = store.pruneRawRecords(20, NOW);
    assert.ok(outcome.prunedRecords > 0, "days 100, 60 and 30 are past a 20-day window");
    assert.ok(outcome.retainedFromDay);

    // The whole promise of retention: the dashboard series does not move.
    assert.deepStrictEqual(totalsByDay(store), before, "pruning must not change any daily total");
    store.close();
  });

  test("rebuilding aggregates after a prune does not erase the pruned days", async () => {
    // The failure this exists to prevent. rebuildAggregates used to clear
    // daily_aggregate outright and recompute it from usage_record, so the first
    // rebuild after a prune would have deleted the user's history permanently
    // — the raw rows behind it were already gone.
    const store = await openStore();
    seedDays(store, [100, 60, 30, 10, 1]);
    const pricing = new PricingEngine({}, undefined);
    rebuildAggregates(store.database, pricing);
    const before = totalsByDay(store);

    store.pruneRawRecords(20, NOW);
    rebuildAggregates(store.database, pricing);

    assert.deepStrictEqual(totalsByDay(store), before, "a rebuild must leave pruned days alone");
    store.close();
  });

  test("the integrity check stays valid after a prune", async () => {
    // It compares raw rows against the aggregates built from them. Retention
    // removes the rows and keeps the aggregates on purpose, so an unscoped
    // comparison called a healthy database corrupt forever — and the worker
    // answers that verdict by rebuilding aggregates on every single scan.
    const store = await openStore();
    seedDays(store, [100, 60, 30, 10, 1]);
    const pricing = new PricingEngine({}, undefined);
    rebuildAggregates(store.database, pricing);
    assert.strictEqual(aggregateIntegrity(store.database).valid, true, "healthy before pruning");

    store.pruneRawRecords(20, NOW);
    assert.strictEqual(
      aggregateIntegrity(store.database).valid,
      true,
      "a pruned database is not a corrupt one",
    );

    rebuildAggregates(store.database, pricing);
    assert.strictEqual(aggregateIntegrity(store.database).valid, true, "and stays valid after a rebuild");
    store.close();
  });

  test("a session still running past the cutoff keeps all of its turns", async () => {
    // Half a session would be recomputed from its remaining turns on the next
    // rebuild, quietly shrinking that session's totals.
    const store = await openStore();
    seedDays(store, [40, 30, 20, 5, 1], { sessionPerDay: false });
    const pricing = new PricingEngine({}, undefined);
    rebuildAggregates(store.database, pricing);
    const before = totalsByDay(store);

    const outcome = store.pruneRawRecords(20, NOW);
    assert.strictEqual(outcome.prunedRecords, 0, "the one session spans the cutoff, so nothing may go");
    const rows = Number(store.database.exec("SELECT COUNT(*) FROM usage_record")[0].values[0][0]);
    assert.strictEqual(rows, 5, "every turn of the straddling session stays");

    rebuildAggregates(store.database, pricing);
    assert.deepStrictEqual(totalsByDay(store), before);
    store.close();
  });

  test("no day is ever left half-pruned", async () => {
    const store = await openStore();
    seedDays(store, [50, 40, 30, 20, 10, 2]);
    store.pruneRawRecords(25, NOW);
    const watermark = store.retainedFromDay();
    assert.ok(watermark);

    const stray = store.database.exec(
      "SELECT COUNT(*) FROM usage_record WHERE day_local < ?", [watermark],
    )[0].values[0][0];
    assert.strictEqual(Number(stray), 0, "nothing may remain below the watermark");
    const strayTools = store.database.exec(
      "SELECT COUNT(*) FROM tool_event WHERE day_local < ?", [watermark],
    )[0].values[0][0];
    assert.strictEqual(Number(strayTools), 0, "tool events follow the same cutoff");
    store.close();
  });

  test("a re-read of the logs cannot resurrect a pruned day", async () => {
    // Cursors still list the pruned records, so a rescan would re-insert a
    // handful of them and put the day back below the watermark in fragments.
    const store = await openStore();
    const file = join(dir, "codex.jsonl");
    writeFileSync(file, `${CODEX_ROLLOUT_JSONL}\n`, "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "codex:1",
    };

    // A watermark in the future: every record in the fixture is "pruned".
    store.setMeta("raw_retained_from_day", "2099-01-01");
    await ingestFile(candidate, store, new PricingEngine({}, undefined), {
      maxLineBytes: 1_048_576, backfillMonths: 0,
    });
    assert.strictEqual(store.usageRecordCount(), 0, "nothing below the watermark may be stored");

    // With no watermark the same file ingests normally, so the guard is the
    // only thing that stopped it.
    const fresh = await openStore("fresh.sqlite");
    await ingestFile(candidate, fresh, new PricingEngine({}, undefined), {
      maxLineBytes: 1_048_576, backfillMonths: 0,
    });
    assert.ok(fresh.usageRecordCount() > 0, "the fixture really does contain records");
    fresh.close();
    store.close();
  });

  test("wiping the database withdraws the watermark", async () => {
    // Everything is re-read from the logs after a wipe, so every day is in play
    // again; a leftover watermark would make the next rebuild preserve stale
    // aggregates for days it is about to recompute properly.
    const store = await openStore();
    seedDays(store, [100, 10]);
    store.pruneRawRecords(20, NOW);
    assert.ok(store.retainedFromDay(), "the prune must have set one");

    store.clearIngestedData();
    assert.strictEqual(store.retainedFromDay(), undefined, "a wipe must clear it");
    store.close();
  });

  test("retention off means nothing is touched", async () => {
    const store = await openStore();
    seedDays(store, [400, 200, 1]);
    const before = store.usageRecordCount();
    for (const days of [0, -5, Number.NaN]) {
      const outcome = store.pruneRawRecords(days, NOW);
      assert.strictEqual(outcome.prunedRecords, 0, `rawRecordDays=${days} must be a no-op`);
      assert.strictEqual(store.retainedFromDay(), undefined, "and must not claim a watermark");
    }
    assert.strictEqual(store.usageRecordCount(), before);
    store.close();
  });

  test("the file actually gets smaller, not just emptier", async () => {
    // Deleted rows leave free pages, and this store writes the whole file on
    // every flush, so a prune that skipped the compaction would cost disk
    // rather than save it.
    const store = await openStore();
    const offsets: number[] = [];
    for (let i = 0; i < 4000; i++) { offsets.push(200 - Math.floor(i / 40)); }
    // Distinct keys per row, so the seed really inserts 4000 turns.
    const db = store.database;
    db.run("BEGIN TRANSACTION");
    offsets.forEach((offset, index) => {
      const ts = NOW - offset * DAY_MS - index;
      const day = localDayFromMs(ts);
      db.run(
        `INSERT INTO usage_record
         (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
          model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens, cost_usd)
         VALUES (?, 'f1', 'codex', ?, ?, ?, 1, 10, 'gpt-5-codex', 'medium', 'gpt-5-codex (medium)', '', 10, 5, 15, 0.5)`,
        [`bulk-${index}`, `s-${day}`, ts, day],
      );
    });
    db.run("COMMIT");
    store.markStructurallyDirty();
    const before = store.database.export().length;

    const outcome = store.pruneRawRecords(30, NOW);
    assert.ok(outcome.prunedRecords > 1000, `expected a big prune, got ${outcome.prunedRecords}`);
    const after = store.database.export().length;
    assert.ok(after < before, `the file must shrink: ${before} -> ${after}`);
    store.close();
  });

  test("the watermark is a whole local day, not a timestamp", async () => {
    const store = await openStore();
    seedDays(store, [100, 1]);
    store.pruneRawRecords(30, NOW);
    const watermark = store.retainedFromDay();
    assert.ok(watermark && /^\d{4}-\d{2}-\d{2}$/.test(watermark), `expected a local day, got ${watermark}`);
    // And it round-trips through the same parser the rebuild guard uses.
    assert.ok(Number.isFinite(parseLocalDay(watermark).getTime()));
    store.close();
  });
});

suite("A pruned database is fenced off from builds that predate retention", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });
  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-crossver-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  async function openStore(name = "db.sqlite"): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, name), SQL);
    await store.migrateOrRebuild();
    return store;
  }

  /**
   * The check every already-shipped build runs before it will touch the file:
   * refuse anything numbered above the schema that build knows. It is the only
   * lever we have over code that is already in people's hands.
   *
   * `itsSchema` names the generation being stood in for: 8 is a build from
   * before dedup keys were compacted, 9 one from before retention.
   */
  function aBuildKnowingSchemaWouldOpen(store: UsageStore, itsSchema: number): boolean {
    return store.schemaVersion() <= itsSchema;
  }

  test("retention being off leaves the version exactly where the upgrade put it", async () => {
    // Compacting the dedup keys already moved every database to 9, and that
    // one genuinely has to lock out builds from before it: they would insert a
    // second copy of any turn they re-read instead of replacing it. Retention
    // must not move the number any further on its own.
    const store = await openStore();
    seedDays(store, [100, 10, 1]);
    assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);

    store.pruneRawRecords(0, NOW);
    assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION, "retention off must change nothing");
    assert.ok(
      aBuildKnowingSchemaWouldOpen(store, SCHEMA_VERSION),
      "a build of this generation must open it",
    );
    assert.strictEqual(
      aBuildKnowingSchemaWouldOpen(store, 8),
      false,
      "a build from before compact keys must not, or it would double-count",
    );
    store.close();
  });

  test("a database with nothing old enough to prune is left readable too", async () => {
    const store = await openStore();
    seedDays(store, [5, 2, 1]);
    const outcome = store.pruneRawRecords(30, NOW);
    assert.strictEqual(outcome.prunedRecords, 0, "nothing is old enough");
    assert.strictEqual(
      store.schemaVersion(),
      SCHEMA_VERSION,
      "no rows were removed, so no aggregate outlives its rows, so nothing more to fence",
    );
    store.close();
  });

  test("the moment rows are actually pruned, older builds are locked out", async () => {
    // Without this an older build reads the surviving aggregates as corruption,
    // rebuilds them from rows that are gone, and deletes the history.
    const store = await openStore();
    seedDays(store, [100, 60, 30, 10, 1]);
    const outcome = store.pruneRawRecords(20, NOW);
    assert.ok(outcome.prunedRecords > 0);

    assert.strictEqual(store.schemaVersion(), PRUNED_SCHEMA_VERSION);
    assert.strictEqual(
      aBuildKnowingSchemaWouldOpen(store, SCHEMA_VERSION),
      false,
      "a build that predates retention must refuse this file",
    );
    store.close();
  });

  test("this build reads a pruned database back off disk", async () => {
    // The other half of the fence: raising the number must not lock US out.
    const store = await openStore();
    seedDays(store, [100, 60, 30, 10, 1]);
    rebuildAggregates(store.database, new PricingEngine({}, undefined));
    const before = totalsByDay(store);
    store.pruneRawRecords(20, NOW);
    store.flush({ force: true });
    store.close();

    const reopened = new UsageStore();
    await reopened.open(join(dir, "db.sqlite"), SQL);
    assert.strictEqual(
      await reopened.migrateOrRebuild(),
      "ok",
      "a pruned database is not something to migrate or rebuild",
    );
    assert.strictEqual(reopened.schemaVersion(), PRUNED_SCHEMA_VERSION);
    assert.deepStrictEqual(totalsByDay(reopened), before, "and the history came back intact");
    assert.ok(reopened.retainedFromDay(), "the watermark survives the round trip");
    reopened.close();
  });

  test("a reset leaves a small file, not an empty large one", async () => {
    // Deleting every row frees pages without shrinking the file, and this store
    // rewrites the whole file on every flush. A reset is what someone reaches for
    // when things have gone wrong; handing back an empty database that still
    // costs its old size on every flush is a poor answer.
    const store = await openStore();
    const db = store.database;
    db.run("BEGIN TRANSACTION");
    for (let i = 0; i < 6000; i++) {
      const ts = NOW - i * 1000;
      db.run(
        `INSERT INTO usage_record
         (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
          model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens)
         VALUES (?, 'f1', 'codex', ?, ?, ?, 1, 10, 'gpt-5-codex', 'medium',
                 'gpt-5-codex (medium)', '', 1, 1, 2)`,
        [`r-${i}`, `s-${i % 20}`, ts, localDayFromMs(ts)],
      );
    }
    db.run("COMMIT");
    store.markStructurallyDirty();
    const filled = store.database.export().length;

    store.resetDatabase();
    const emptied = store.database.export().length;
    assert.strictEqual(store.usageRecordCount(), 0);
    assert.ok(
      emptied < filled / 2,
      `an emptied database must actually be small: ${filled} -> ${emptied}`,
    );
    store.close();
  });

  test("a reset lifts the retention fence, but not the compact-key one", async () => {
    // Nothing is pruned after a wipe, so the reason builds from before retention
    // were kept out has gone with the data. The keys are still compact though,
    // and a build from before that change would still double-count, so the
    // version drops to SCHEMA_VERSION and no further.
    const store = await openStore();
    seedDays(store, [100, 10]);
    store.pruneRawRecords(20, NOW);
    assert.strictEqual(store.schemaVersion(), PRUNED_SCHEMA_VERSION);

    store.clearIngestedData();
    assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);
    assert.ok(
      aBuildKnowingSchemaWouldOpen(store, SCHEMA_VERSION),
      "a build of this generation can open it again",
    );
    assert.strictEqual(
      aBuildKnowingSchemaWouldOpen(store, 8),
      false,
      "the compact keys are still compact, so that fence stays up",
    );

    // And the harder reset does the same.
    seedDays(store, [100, 10]);
    store.pruneRawRecords(20, NOW);
    assert.strictEqual(store.schemaVersion(), PRUNED_SCHEMA_VERSION);
    store.resetDatabase();
    assert.strictEqual(store.schemaVersion(), SCHEMA_VERSION);
    store.close();
  });

  test("a database this build cannot read is still refused", async () => {
    // The fence must not become a hole: anything above what we understand has
    // to be rejected, not opened hopefully.
    const store = await openStore();
    store.setMeta("schema_version", String(PRUNED_SCHEMA_VERSION + 1));
    await assert.rejects(() => store.migrateOrRebuild(), /newer than supported/);
    store.close();
  });
});
