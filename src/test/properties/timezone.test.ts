// Regression guard: store writes day_local using the LOCAL calendar day, and
// queries filter day_local using the SAME local-day derivation. A record whose
// UTC day differs from its local day (i.e. near a local-midnight boundary) must
// still be found by a query whose range covers that local day.
//
// This protects against re-introducing the local-vs-UTC mismatch where the
// store wrote local days but queries filtered by UTC days.

import * as assert from "assert";
import initSqlJs, { Database } from "sql.js";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { dailySeries } from "../../worker/store/queries.js";
import { localDay, localDayFromMs } from "../../shared/time.js";
import { totalTokens } from "../../shared/types.js";
import type { UsageRecord } from "../../shared/types.js";
import type { StoreBatch } from "../../shared/storeTypes.js";

async function freshDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  return db;
}

function storeFromDb(db: Database): UsageStore {
  const store = new UsageStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db = db;
  return store;
}

function singleRecordBatch(rec: UsageRecord): StoreBatch {
  return {
    records: [rec],
    toolEvents: [],
    contribution: {
      daily: [{
        day: localDay(new Date(rec.timestamp)),
        source: rec.source,
        variantId: rec.variantId,
        workspace: rec.workspace ?? "",
        sums: {
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheCreationTokens: rec.cacheCreationTokens,
          reasoningTokens: rec.reasoningTokens,
        },
        turns: 1,
        costUsd: 0,
        unknownTurns: 0,
      }],
      sessions: [],
      recordKeys: [rec.dedupKey],
      toolEventCount: 0,
    },
  };
}

suite("Timezone local-day consistency", () => {
  test("a record is found by a query whose range covers its LOCAL day", async () => {
    const db = await freshDb();
    const store = storeFromDb(db);

    // Pick "today" at local 09:00 — unambiguously inside today's local day.
    const now = new Date();
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).getTime();

    const rec: UsageRecord = {
      source: "codex",
      sessionId: "tz-sess",
      dedupKey: "codex:tz-sess:0",
      timestamp: ts,
      model: "gpt-5-codex",
      variantId: "gpt-5-codex",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
    store.applyFileResult("file-tz", singleRecordBatch(rec));

    // Query "today" using local start/end-of-day epoch boundaries, exactly like
    // StatusBarController does.
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 86_400_000 - 1;

    const series = dailySeries(db, {
      view: "series",
      granularity: "day",
      range: { fromUtc: startOfDay, toUtc: endOfDay },
      rollupToBaseModel: false,
    });

    const total = series.reduce((s, r) => s + r.totalTokens, 0);
    assert.strictEqual(total, totalTokens(rec), "today's record should be inside today's local-day range");
    db.close();
  });

  test("query-path day-string (localDayFromMs) matches write-path day-string (localDay)", () => {
    // The store writes day_local via localDay(new Date(ms)); queries derive their
    // range boundaries via localDayFromMs(ms). These two MUST agree for every
    // timestamp, otherwise range filters drift from stored rows.
    const samples = [
      Date.now(),
      new Date(2026, 0, 1, 0, 30, 0).getTime(),   // just after local midnight
      new Date(2026, 0, 1, 23, 30, 0).getTime(),  // just before local midnight
      new Date(2026, 5, 15, 12, 0, 0).getTime(),  // mid-day
      0,                                          // epoch
    ];
    for (const ms of samples) {
      const writePath = localDay(new Date(ms));
      const queryPath = localDayFromMs(ms);
      assert.strictEqual(queryPath, writePath, `day-string mismatch at ${ms}`);
    }
  });
});
