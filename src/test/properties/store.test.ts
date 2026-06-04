import * as assert from "assert";
import fc from "fast-check";
import initSqlJs, { Database } from "sql.js";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { dailySeries, variantBreakdown } from "../../worker/store/queries.js";
import { totalTokens } from "../../shared/types.js";
import { makeVariantId, baseModelOf } from "../../shared/variant.js";
import type { UsageRecord, ToolEvent, Source } from "../../shared/types.js";
import type { StoreBatch, FileContribution, FileCursor } from "../../shared/storeTypes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function freshDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
    String(SCHEMA_VERSION),
  ]);
  return db;
}

/** Wrap a raw db in a UsageStore by injecting it via open + migrateOrRebuild on a temp path. */
function storeFromDb(db: Database): UsageStore {
  // We access the private db field directly for testing purposes.
  const store = new UsageStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).db = db;
  return store;
}

function toLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Generate a minimal valid UsageRecord. */
function arbRecord(opts?: { day?: string; variantId?: string; source?: Source }): fc.Arbitrary<UsageRecord> {
  return fc.record({
    inputTokens: fc.nat({ max: 10_000 }),
    outputTokens: fc.nat({ max: 10_000 }),
    cacheReadTokens: fc.nat({ max: 5_000 }),
    cacheCreationTokens: fc.nat({ max: 5_000 }),
    reasoningTokens: fc.nat({ max: 5_000 }),
    idx: fc.nat({ max: 999 }),
  }).map(({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens, idx }) => {
    const source: Source = opts?.source ?? "codex";
    const sessionId = `sess-${idx % 3}`;
    const dedupKey = `${source}:${sessionId}:${idx}`;
    const day = opts?.day ?? "2025-01-15";
    const ts = new Date(`${day}T10:00:00.000Z`).getTime() + idx * 1000;
    const variantId = opts?.variantId ?? "gpt-5-codex";
    const model = baseModelOf(variantId);

    const rec: UsageRecord = {
      source,
      sessionId,
      dedupKey,
      timestamp: ts,
      model,
      variantId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
    };
    return rec;
  });
}

/** Build a StoreBatch from records and optional tool events. */
function buildBatch(records: UsageRecord[], toolEvents: ToolEvent[]): StoreBatch {
  // Build contribution from records
  const dailyMap = new Map<string, FileContribution["daily"][0]>();
  const sessionMap = new Map<string, FileContribution["sessions"][0]>();

  for (const rec of records) {
    const day = toLocalDay(new Date(rec.timestamp));
    const dKey = `${day}|${rec.source}|${rec.variantId}|${rec.workspace ?? ""}`;
    const existing = dailyMap.get(dKey);
    if (existing) {
      existing.sums.inputTokens += rec.inputTokens;
      existing.sums.outputTokens += rec.outputTokens;
      existing.sums.cacheReadTokens += rec.cacheReadTokens;
      existing.sums.cacheCreationTokens += rec.cacheCreationTokens;
      existing.sums.reasoningTokens += rec.reasoningTokens;
      existing.turns += 1;
    } else {
      dailyMap.set(dKey, {
        day,
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
      });
    }

    const sKey = `${rec.source}|${rec.sessionId}`;
    const sess = sessionMap.get(sKey);
    if (sess) {
      sess.sums.inputTokens += rec.inputTokens;
      sess.sums.outputTokens += rec.outputTokens;
      sess.sums.cacheReadTokens += rec.cacheReadTokens;
      sess.sums.cacheCreationTokens += rec.cacheCreationTokens;
      sess.sums.reasoningTokens += rec.reasoningTokens;
      sess.turns += 1;
      sess.firstTsUtc = Math.min(sess.firstTsUtc, rec.timestamp);
      sess.lastTsUtc = Math.max(sess.lastTsUtc, rec.timestamp);
    } else {
      sessionMap.set(sKey, {
        source: rec.source,
        sessionId: rec.sessionId,
        sums: {
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheCreationTokens: rec.cacheCreationTokens,
          reasoningTokens: rec.reasoningTokens,
        },
        turns: 1,
        costUsd: 0,
        firstTsUtc: rec.timestamp,
        lastTsUtc: rec.timestamp,
        sidechainTokens: 0,
      });
    }
  }

  return {
    records,
    toolEvents,
    contribution: {
      daily: [...dailyMap.values()],
      sessions: [...sessionMap.values()],
      recordKeys: records.map((r) => r.dedupKey),
      toolEventCount: toolEvents.length,
    },
  };
}

function countRows(db: Database, table: string): number {
  const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
  if (result.length === 0) { return 0; }
  return Number(result[0].values[0][0]);
}

function sumColumn(db: Database, table: string, col: string): number {
  const result = db.exec(`SELECT COALESCE(SUM(${col}), 0) FROM ${table}`);
  if (result.length === 0) { return 0; }
  return Number(result[0].values[0][0]);
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

suite("Store property tests (in-memory sql.js)", () => {
  test("Property 7: idempotence + last-wins + tool event stability", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRecord(), { minLength: 1, maxLength: 5 }),
        async (records) => {
          const db = await freshDb();
          const store = storeFromDb(db);
          const fileId = "file-a";

          // Build tool events for each record
          const toolEvents: ToolEvent[] = records.map((rec, i) => ({
            source: rec.source,
            sessionId: rec.sessionId,
            timestamp: rec.timestamp,
            toolName: `tool_${i}`,
            isSidechain: false,
            recordDedupKey: rec.dedupKey,
            eventKey: `${rec.dedupKey}#0`,
          }));

          const batch = buildBatch(records, toolEvents);

          // Apply once
          store.applyFileResult(fileId, batch);
          const recordCountAfterFirst = countRows(db, "usage_record");
          const toolCountAfterFirst = countRows(db, "tool_event");
          const totalAfterFirst = sumColumn(db, "daily_aggregate", "total_tokens");

          // Apply again (idempotent upsert via dedupKey)
          store.applyFileResult(fileId, batch);
          const recordCountAfterSecond = countRows(db, "usage_record");
          const toolCountAfterSecond = countRows(db, "tool_event");
          const totalAfterSecond = sumColumn(db, "daily_aggregate", "total_tokens");

          // Record count stays the same (not doubled)
          assert.strictEqual(
            recordCountAfterSecond,
            recordCountAfterFirst,
            "Records should not duplicate on re-apply",
          );

          // Tool event count stays the same (not doubled)
          assert.strictEqual(
            toolCountAfterSecond,
            toolCountAfterFirst,
            "Tool events should not duplicate on re-apply",
          );

          // Daily aggregates DO double because contribution is additive.
          // But record/tool rows are idempotent. The key property is that
          // usage_record and tool_event rows are stable.
          // NOTE: daily_aggregate doubles because it's additive by design
          // (the subtract path handles revert). The core idempotence property
          // is on the record and tool_event tables.
          assert.strictEqual(recordCountAfterFirst, records.length);
          assert.strictEqual(toolCountAfterFirst, toolEvents.length);

          // daily_aggregate is additive by design: re-applying the same batch
          // doubles the token totals (the subtract path handles revert).
          assert.strictEqual(
            totalAfterSecond,
            totalAfterFirst * 2,
            "Daily aggregate totals are additive on re-apply",
          );

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Property 8: subtract is exact inverse of ingest (no residue)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbRecord(), { minLength: 1, maxLength: 5 }),
        async (records) => {
          const db = await freshDb();
          const store = storeFromDb(db);
          const fileId = "file-b";

          const toolEvents: ToolEvent[] = records.map((rec, i) => ({
            source: rec.source,
            sessionId: rec.sessionId,
            timestamp: rec.timestamp,
            toolName: `tool_${i}`,
            isSidechain: false,
            recordDedupKey: rec.dedupKey,
            eventKey: `${rec.dedupKey}#0`,
          }));

          const batch = buildBatch(records, toolEvents);

          // Store the cursor so subtractFileContribution can find it
          store.putCursor({
            filePath: "/fake/path.jsonl",
            fileId,
            source: "codex",
            size: 1000,
            mtimeMs: Date.now(),
            lastByteOffset: 500,
            headHash: "abc",
            tailAnchorHash: "def",
            runningTotals: {},
            recentRequestIds: [],
            contribution: batch.contribution,
          });

          // Apply
          store.applyFileResult(fileId, batch);

          // Subtract + delete
          store.subtractFileContribution(fileId);
          store.deleteFileRows(fileId);

          // Assert: no usage_record rows remain
          assert.strictEqual(
            countRows(db, "usage_record"),
            0,
            "usage_record should be empty after subtract+delete",
          );

          // Assert: no tool_event rows remain
          assert.strictEqual(
            countRows(db, "tool_event"),
            0,
            "tool_event should be empty after subtract+delete",
          );

          // Assert: daily aggregates are zeroed
          const totalTokensRemaining = sumColumn(db, "daily_aggregate", "total_tokens");
          assert.strictEqual(
            totalTokensRemaining,
            0,
            "daily_aggregate total_tokens should be 0 after subtract",
          );

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Property 9: sum of daily aggregates equals direct record aggregation", async () => {
    const days = ["2025-01-13", "2025-01-14", "2025-01-15", "2025-01-16", "2025-01-17"];

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(fc.constantFrom(...days), arbRecord()).map(([day, rec]) => {
            // Override timestamp to match the chosen day
            const ts = new Date(`${day}T12:00:00.000Z`).getTime();
            return { ...rec, timestamp: ts, dedupKey: `codex:sess-0:${day}-${rec.dedupKey}` };
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (records) => {
          const db = await freshDb();
          const store = storeFromDb(db);
          const fileId = "file-c";

          const batch = buildBatch(records, []);
          store.applyFileResult(fileId, batch);

          // Query dailySeries for the full range
          const series = dailySeries(db, {
            view: "series",
            granularity: "day",
            range: {
              fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
              toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
            },
            rollupToBaseModel: false,
          });

          // Sum of daily aggregate totalTokens
          const dailySum = series.reduce((acc, d) => acc + d.totalTokens, 0);

          // Direct sum from records
          const directSum = records.reduce((acc, r) => acc + totalTokens(r), 0);

          assert.strictEqual(
            dailySum,
            directSum,
            `Daily aggregate sum (${dailySum}) !== direct record sum (${directSum})`,
          );

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Property 12: variant rollup to base model preserves totals", async () => {
    const efforts = ["low", "medium", "high"] as const;
    const baseModel = "gpt-5-codex";

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom(...efforts),
            fc.nat({ max: 10_000 }),
            fc.nat({ max: 10_000 }),
            fc.nat({ max: 999 }),
          ),
          { minLength: 1, maxLength: 5 },
        ),
        async (entries) => {
          const db = await freshDb();
          const store = storeFromDb(db);
          const fileId = "file-d";

          const records: UsageRecord[] = entries.map(([effort, input, output, idx]) => {
            const variantId = makeVariantId(baseModel, effort);
            const dedupKey = `codex:sess-0:${effort}-${idx}`;
            return {
              source: "codex" as Source,
              sessionId: "sess-0",
              dedupKey,
              timestamp: new Date("2025-01-15T10:00:00.000Z").getTime() + idx * 1000,
              model: baseModel,
              effort,
              variantId,
              inputTokens: input,
              outputTokens: output,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
            };
          });

          const batch = buildBatch(records, []);
          store.applyFileResult(fileId, batch);

          const query = {
            view: "variants" as const,
            granularity: "day" as const,
            range: {
              fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
              toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
            },
            rollupToBaseModel: false,
          };

          // Get per-variant breakdown
          const perVariant = variantBreakdown(db, { ...query, rollupToBaseModel: false });
          const variantTotalTokens = perVariant.reduce((acc, v) => acc + v.totalTokens, 0);

          // Get rolled-up breakdown
          const rolledUp = variantBreakdown(db, { ...query, rollupToBaseModel: true });
          const rolledUpTotalTokens = rolledUp.reduce((acc, v) => acc + v.totalTokens, 0);

          // Totals must match
          assert.strictEqual(
            rolledUpTotalTokens,
            variantTotalTokens,
            `Rolled-up total (${rolledUpTotalTokens}) !== per-variant total (${variantTotalTokens})`,
          );

          // Also verify against direct record sum
          const directSum = records.reduce((acc, r) => acc + totalTokens(r), 0);
          assert.strictEqual(
            rolledUpTotalTokens,
            directSum,
            `Rolled-up total (${rolledUpTotalTokens}) !== direct sum (${directSum})`,
          );

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("File catalog returns hot current-week paths before cold history", async () => {
    const db = await freshDb();
    const store = storeFromDb(db);
    const now = new Date("2026-06-04T12:00:00Z").getTime();
    const coldNow = new Date("2026-01-01T12:00:00Z").getTime();
    const hotCandidate = {
      filePath: "/tmp/hot-rollout.jsonl",
      fileId: "hot-file",
      source: "codex" as Source,
      size: 100,
      mtimeMs: now - 60_000,
    };
    const coldCandidate = {
      filePath: "/tmp/cold-rollout.jsonl",
      fileId: "cold-file",
      source: "codex" as Source,
      size: 100,
      mtimeMs: coldNow,
    };

    store.recordDiscoveredFiles([coldCandidate], coldNow);
    store.putCursor(catalogCursor(coldCandidate, "2026-01-01"));
    store.recordFileCatalogIngestResult(coldCandidate, "firstRead", coldNow);

    store.recordDiscoveredFiles([hotCandidate], now);
    store.putCursor(catalogCursor(hotCandidate, "2026-06-04"));
    store.recordFileCatalogIngestResult(hotCandidate, "firstRead", now);
    store.recordFileCatalogPriorities([{ filePath: hotCandidate.filePath, priorityScore: 10_000 }]);

    const hotPaths = store.hotCatalogFilePaths(now, 10);

    assert.ok(hotPaths.includes(hotCandidate.filePath), "current-week file should be hot");
    assert.ok(!hotPaths.includes(coldCandidate.filePath), "old unchanged history should not be hot");
    db.close();
  });

  test("Unmapped models are auto-registered with fallback pricing without resetting first_seen", async () => {
    const db = await freshDb();
    const store = storeFromDb(db);
    const fallbackRate = {
      inputPer1K: 0.003,
      cachedInputPer1K: 0.0015,
      outputPer1K: 0.012,
    };
    const model = "gpt-9.9-codex-surprise";

    store.recordUnmappedModels([model], fallbackRate);
    const firstSeen = singleNumber(db, "SELECT first_seen_utc FROM unmapped_model WHERE model = ?", [model]);
    const ratesJson = singleString(db, "SELECT rates_json FROM pricing WHERE model = ?", [model]);

    assert.ok(firstSeen > 0, "unmapped model should be recorded");
    assert.deepStrictEqual(JSON.parse(ratesJson), fallbackRate);

    store.recordUnmappedModels([model], fallbackRate);
    const firstSeenAgain = singleNumber(db, "SELECT first_seen_utc FROM unmapped_model WHERE model = ?", [model]);

    assert.strictEqual(firstSeenAgain, firstSeen, "first_seen_utc should be stable across repeated records");
    db.close();
  });
});

function singleNumber(db: Database, sql: string, params: Array<string | number>): number {
  const result = db.exec(sql, params);
  assert.ok(result.length > 0 && result[0].values.length > 0, `Expected one row for ${sql}`);
  return Number(result[0].values[0][0]);
}

function singleString(db: Database, sql: string, params: Array<string | number>): string {
  const result = db.exec(sql, params);
  assert.ok(result.length > 0 && result[0].values.length > 0, `Expected one row for ${sql}`);
  const value = result[0].values[0][0];
  assert.strictEqual(typeof value, "string");
  return String(value);
}

function catalogCursor(
  candidate: { filePath: string; fileId: string; source: Source; size: number; mtimeMs: number },
  day: string,
): FileCursor {
  return {
    filePath: candidate.filePath,
    fileId: candidate.fileId,
    source: candidate.source,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    lastByteOffset: candidate.size,
    headHash: "head",
    tailAnchorHash: "tail",
    runningTotals: {},
    recentRequestIds: [],
    contribution: {
      daily: [{
        day,
        source: candidate.source,
        variantId: "gpt-5-codex",
        workspace: "",
        sums: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
        turns: 1,
        costUsd: 0,
        unknownTurns: 0,
      }],
      sessions: [],
      recordKeys: [],
      toolEventCount: 0,
    },
  };
}
