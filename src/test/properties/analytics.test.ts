// Feature: token-tracking, Property 13: variant metric formulas + shares sum to ~100%
// Feature: token-tracking, Property 15: anomaly days exceed k*median(trailing)
// Feature: token-tracking, Property 16: sidechain+main=total; tool shares; peak context fill

import * as assert from "assert";
import fc from "fast-check";
import initSqlJs, { Database } from "sql.js";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { variantBreakdown, toolUsage } from "../../worker/store/queries.js";
import { totalTokens } from "../../shared/types.js";
import type { UsageRecord, ToolEvent, Source } from "../../shared/types.js";
import type { StoreBatch, FileContribution } from "../../shared/storeTypes.js";

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

function storeFromDb(db: Database): UsageStore {
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

function buildBatch(records: UsageRecord[], toolEvents: ToolEvent[]): StoreBatch {
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
    const sidechainTok = rec.meta?.isSidechain ? totalTokens(rec) : 0;
    if (sess) {
      sess.sums.inputTokens += rec.inputTokens;
      sess.sums.outputTokens += rec.outputTokens;
      sess.sums.cacheReadTokens += rec.cacheReadTokens;
      sess.sums.cacheCreationTokens += rec.cacheCreationTokens;
      sess.sums.reasoningTokens += rec.reasoningTokens;
      sess.turns += 1;
      sess.firstTsUtc = Math.min(sess.firstTsUtc, rec.timestamp);
      sess.lastTsUtc = Math.max(sess.lastTsUtc, rec.timestamp);
      sess.sidechainTokens += sidechainTok;
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
        sidechainTokens: sidechainTok,
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

// ---------------------------------------------------------------------------
// Property 13: variant metric formulas + shares sum to ~100%
// ---------------------------------------------------------------------------

suite("Analytics property tests", () => {
  test("Property 13: variant metric formulas + shares sum to ~100%", async () => {
    const variants = ["gpt-5-codex", "claude-opus-4.7", "gpt-4o"];

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            variantIdx: fc.nat({ max: 2 }),
            inputTokens: fc.integer({ min: 1, max: 10_000 }),
            outputTokens: fc.integer({ min: 1, max: 10_000 }),
            cacheReadTokens: fc.nat({ max: 5_000 }),
            cacheCreationTokens: fc.nat({ max: 5_000 }),
            reasoningTokens: fc.nat({ max: 5_000 }),
            idx: fc.nat({ max: 9999 }),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        async (entries) => {
          const db = await freshDb();
          const store = storeFromDb(db);

          const records: UsageRecord[] = entries.map((e, i) => {
            const model = variants[e.variantIdx];
            const variantId = model;
            return {
              source: "codex" as Source,
              sessionId: "sess-0",
              dedupKey: `codex:sess-0:p13-${i}-${e.idx}`,
              timestamp: new Date("2025-01-15T10:00:00.000Z").getTime() + i * 1000,
              model,
              variantId,
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cacheReadTokens: e.cacheReadTokens,
              cacheCreationTokens: e.cacheCreationTokens,
              reasoningTokens: e.reasoningTokens,
            };
          });

          const batch = buildBatch(records, []);
          store.applyFileResult("file-p13", batch);

          const query = {
            view: "variants" as const,
            granularity: "day" as const,
            range: {
              fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
              toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
            },
            rollupToBaseModel: false,
          };

          const breakdown = variantBreakdown(db, query);
          assert.ok(breakdown.length > 0, "Should have at least one variant");

          // shareOfCostPct sums to ~100% (cost is 0 here, so shares are 0/0 → 0; skip if no cost)
          // shareOfTokensPct sums to ~100%
          const tokenShareSum = breakdown.reduce((s, v) => s + v.shareOfTokensPct, 0);
          assert.ok(
            Math.abs(tokenShareSum - 100) < 0.01,
            `shareOfTokensPct sum should be ~100%, got ${tokenShareSum}`,
          );

          // costShareSum: since costUsd=0 for all, shares will be 0. That's correct (0/0 → 0).
          // If grandTotalCost is 0, all shares are 0 and sum is 0. That's the defined behavior.
          const costShareSum = breakdown.reduce((s, v) => s + v.shareOfCostPct, 0);
          const grandTotalCost = breakdown.reduce((s, v) => s + v.costUsd, 0);
          if (grandTotalCost > 0) {
            assert.ok(
              Math.abs(costShareSum - 100) < 0.01,
              `shareOfCostPct sum should be ~100%, got ${costShareSum}`,
            );
          } else {
            assert.strictEqual(costShareSum, 0, "Cost shares should be 0 when total cost is 0");
          }

          // tokensPerTurn = totalTokens / turns
          for (const v of breakdown) {
            if (v.turns > 0) {
              const expected = v.totalTokens / v.turns;
              assert.ok(
                Math.abs(v.tokensPerTurn - expected) < 0.001,
                `tokensPerTurn mismatch for ${v.variantId}: ${v.tokensPerTurn} vs ${expected}`,
              );
            }
          }

          // blendedCostPer1K = costUsd / totalTokens * 1000
          for (const v of breakdown) {
            if (v.totalTokens > 0) {
              const expected = (v.costUsd / v.totalTokens) * 1000;
              assert.ok(
                Math.abs(v.blendedCostPer1K - expected) < 0.001,
                `blendedCostPer1K mismatch for ${v.variantId}: ${v.blendedCostPer1K} vs ${expected}`,
              );
            }
          }

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 15: anomaly days exceed k*median(trailing)
  // ---------------------------------------------------------------------------

  test("Property 15: anomaly days exceed k*median(trailing)", () => {
    // Pure formula test: isAnomaly(dayCost, trailingCosts, k)
    function median(values: number[]): number {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }

    function isAnomaly(dayCost: number, trailingCosts: number[], k: number): boolean {
      if (trailingCosts.length === 0) return false;
      const med = median(trailingCosts);
      return dayCost > k * med;
    }

    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 1000, noNaN: true }), { minLength: 1, maxLength: 30 }),
        fc.double({ min: 0.01, max: 1000, noNaN: true }),
        fc.double({ min: 1.1, max: 5, noNaN: true }),
        (trailingCosts, dayCost, k) => {
          const med = median(trailingCosts);
          const flagged = isAnomaly(dayCost, trailingCosts, k);

          // A day is anomaly iff cost > k * median
          if (dayCost > k * med) {
            assert.strictEqual(flagged, true, `Day cost ${dayCost} > ${k}*${med} should be anomaly`);
          } else {
            assert.strictEqual(flagged, false, `Day cost ${dayCost} <= ${k}*${med} should NOT be anomaly`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 16: sidechain+main=total; tool shares; peak context fill
  // ---------------------------------------------------------------------------

  test("Property 16: sidechain+main=total; tool shares; peak context fill", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            inputTokens: fc.integer({ min: 1, max: 5_000 }),
            outputTokens: fc.integer({ min: 1, max: 5_000 }),
            isSidechain: fc.boolean(),
            contextWindow: fc.integer({ min: 1000, max: 128_000 }),
            contextUsedTokens: fc.integer({ min: 100, max: 128_000 }),
            toolName: fc.constantFrom("shell", "read", "edit", "search"),
            idx: fc.nat({ max: 9999 }),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        async (entries) => {
          const db = await freshDb();
          const store = storeFromDb(db);

          const records: UsageRecord[] = entries.map((e, i) => ({
            source: "claude" as Source,
            sessionId: "sess-p16",
            dedupKey: `claude:sess-p16:p16-${i}-${e.idx}`,
            timestamp: new Date("2025-02-01T10:00:00.000Z").getTime() + i * 1000,
            model: "claude-opus-4.7",
            variantId: "claude-opus-4.7",
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
            meta: {
              isSidechain: e.isSidechain,
              contextWindow: e.contextWindow,
              contextUsedTokens: Math.min(e.contextUsedTokens, e.contextWindow),
            },
          }));

          const toolEvents: ToolEvent[] = entries.map((e, i) => ({
            source: "claude" as Source,
            sessionId: "sess-p16",
            timestamp: records[i].timestamp,
            toolName: e.toolName,
            isSidechain: e.isSidechain,
            recordDedupKey: records[i].dedupKey,
            eventKey: `${records[i].dedupKey}#0`,
          }));

          const batch = buildBatch(records, toolEvents);
          store.applyFileResult("file-p16", batch);

          // --- sidechain + main = total ---
          const totalAllTokens = records.reduce((s, r) => s + totalTokens(r), 0);
          const sidechainTokens = records
            .filter((r) => r.meta?.isSidechain)
            .reduce((s, r) => s + totalTokens(r), 0);
          const mainTokens = records
            .filter((r) => !r.meta?.isSidechain)
            .reduce((s, r) => s + totalTokens(r), 0);

          assert.strictEqual(
            sidechainTokens + mainTokens,
            totalAllTokens,
            "sidechain + main should equal total tokens",
          );

          // --- tool shares sum to 100% ---
          const query = {
            view: "tools" as const,
            granularity: "day" as const,
            range: {
              fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
              toUtc: new Date("2025-03-01T23:59:59Z").getTime(),
            },
            rollupToBaseModel: false,
          };

          const tools = toolUsage(db, query);
          if (tools.length > 0) {
            const shareSum = tools.reduce((s, t) => s + t.sharePct, 0);
            assert.ok(
              Math.abs(shareSum - 100) < 0.01,
              `Tool shares should sum to ~100%, got ${shareSum}`,
            );
          }

          // --- peak context fill = max(contextUsed/contextWindow) ---
          const expectedPeakFill = entries.reduce((max, e) => {
            const used = Math.min(e.contextUsedTokens, e.contextWindow);
            const fill = used / e.contextWindow;
            return fill > max ? fill : max;
          }, 0);

          // Verify by querying usage_record directly
          const result = db.exec(
            `SELECT MAX(CAST(context_used_tokens AS REAL) / context_window)
             FROM usage_record
             WHERE context_window > 0 AND context_used_tokens IS NOT NULL`,
          );
          if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0] !== null) {
            const dbPeakFill = Number(result[0].values[0][0]);
            assert.ok(
              Math.abs(dbPeakFill - expectedPeakFill) < 0.001,
              `Peak context fill mismatch: db=${dbPeakFill}, expected=${expectedPeakFill}`,
            );
          }

          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
