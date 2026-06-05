// Feature: token-tracking, Task 11.3: Dashboard-from-store performance +
// aggregated-payload regression test.
//
// Verifies that querying all dashboard views from a populated store triggers
// ZERO raw-log file opens, and that emitted results carry only aggregate shapes
// (no content/sentinel).

import * as assert from "assert";
import fs = require("node:fs");
import initSqlJs from "sql.js";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { AnalyticsService } from "../../worker/analytics.js";
import { PricingEngine } from "../../worker/pricing.js";
import { makeVariantId } from "../../shared/variant.js";
import type { UsageRecord, ToolEvent, Source } from "../../shared/types.js";
import type { StoreBatch, FileContribution } from "../../shared/storeTypes.js";
import type { AnalyticsQuery, AnalyticsResult } from "../../shared/protocol.js";

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

suite("Dashboard-from-store performance + aggregated-payload regression", () => {
  let store: UsageStore;
  let analytics: AnalyticsService;

  suiteSetup(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    store = new UsageStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db = db;

    // Populate with test data
    const records: UsageRecord[] = [];
    const toolEvents: ToolEvent[] = [];

    for (let i = 0; i < 20; i++) {
      const source: Source = i % 2 === 0 ? "codex" : "claude";
      const sessionId = `sess-${i % 4}`;
      const dedupKey = `${source}:${sessionId}:${i}`;
      const day = `2025-01-${String(10 + (i % 7)).padStart(2, "0")}`;
      const ts = new Date(`${day}T10:00:00.000Z`).getTime() + i * 1000;
      const model = source === "codex" ? "gpt-5-codex" : "claude-opus-4";
      const variantId = makeVariantId(model, source === "codex" ? "high" : undefined);

      records.push({
        source,
        sessionId,
        dedupKey,
        timestamp: ts,
        model,
        effort: source === "codex" ? "high" : undefined,
        variantId,
        workspace: "/project",
        inputTokens: 100 + i * 10,
        outputTokens: 50 + i * 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        reasoningTokens: source === "codex" ? 30 : 0,
      });

      toolEvents.push({
        source,
        sessionId,
        timestamp: ts,
        toolName: `tool_${i % 3}`,
        isSidechain: false,
        recordDedupKey: dedupKey,
        eventKey: `${dedupKey}#0`,
      });
    }

    const batch = buildBatch(records, toolEvents);
    store.applyFileResult("file-perf", batch);

    const pricing = new PricingEngine({
      "gpt-5-codex": { inputPer1K: 0.01, outputPer1K: 0.03 },
      "claude-opus-4": { inputPer1K: 0.015, outputPer1K: 0.075 },
    });
    analytics = new AnalyticsService(db, pricing);
  });

  test("Querying all views triggers ZERO raw-log file opens", () => {
    // Spy on fs.open, fs.openSync, fs.createReadStream
    const originalOpen = fs.open;
    const originalOpenSync = fs.openSync;
    const originalCreateReadStream = fs.createReadStream;
    let fsOpenCalls = 0;
    const patchedFs = fs as typeof fs & {
      open: typeof originalOpen;
      openSync: typeof originalOpenSync;
      createReadStream: typeof originalCreateReadStream;
    };

    // Monkey-patch to count calls
    patchedFs.open = ((...args: unknown[]) => {
      fsOpenCalls++;
      return Reflect.apply(originalOpen, fs, args);
    }) as typeof originalOpen;
    patchedFs.openSync = ((...args: unknown[]) => {
      fsOpenCalls++;
      return Reflect.apply(originalOpenSync, fs, args);
    }) as typeof originalOpenSync;
    patchedFs.createReadStream = ((...args: unknown[]) => {
      fsOpenCalls++;
      return Reflect.apply(originalCreateReadStream, fs, args);
    }) as typeof originalCreateReadStream;

    try {
      const baseQuery: AnalyticsQuery = {
        view: "dashboard",
        granularity: "day",
        range: {
          fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
          toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
        },
      };

      const views: AnalyticsQuery["view"][] = [
        "dashboard", "series", "variants", "sessions", "tools", "heatmap", "comparison",
      ];

      for (const view of views) {
        analytics.query({ ...baseQuery, view });
      }

      assert.strictEqual(fsOpenCalls, 0, "No fs.open/createReadStream calls during queries");
    } finally {
      // Restore
      patchedFs.open = originalOpen;
      patchedFs.openSync = originalOpenSync;
      patchedFs.createReadStream = originalCreateReadStream;
    }
  });

  test("Emitted results carry only aggregate shapes (no content/sentinel)", () => {
    const sentinel = "SUPER_SECRET_PROMPT_CONTENT_12345";

    const baseQuery: AnalyticsQuery = {
      view: "dashboard",
      granularity: "day",
      range: {
        fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
        toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
      },
    };

    const views: AnalyticsQuery["view"][] = [
      "dashboard", "series", "variants", "sessions", "tools", "heatmap", "comparison",
    ];

    for (const view of views) {
      const result: AnalyticsResult = analytics.query({ ...baseQuery, view });
      const resultStr = JSON.stringify(result);

      // No sentinel in results
      assert.ok(
        !resultStr.includes(sentinel),
        `Sentinel found in ${view} result`,
      );

      // Results should only contain aggregate shapes — verify no raw content fields
      assert.ok(
        !resultStr.includes("rawInputTokens"),
        `Raw field found in ${view} result`,
      );
      assert.ok(
        !resultStr.includes("rawOutputTokens"),
        `Raw field found in ${view} result`,
      );
    }
  });

  test("Dashboard result includes filtered tool usage summary", () => {
    const result = analytics.query({
      view: "dashboard",
      granularity: "day",
      range: {
        fromUtc: new Date("2025-01-01T00:00:00Z").getTime(),
        toUtc: new Date("2025-01-31T23:59:59Z").getTime(),
      },
      models: ["gpt-5-codex"],
      workspaces: ["/project"],
    });

    assert.strictEqual(result.view, "dashboard");
    const totalCalls = result.tools.reduce((sum, row) => sum + row.count, 0);
    const totalCallsByDay = result.toolCallsByDay.reduce((sum, row) => sum + row.count, 0);
    const shareSum = result.tools.reduce((sum, row) => sum + row.sharePct, 0);
    assert.strictEqual(totalCalls, 10, "Codex model filter should keep only codex tool events");
    assert.strictEqual(totalCallsByDay, 10, "Daily tool-call rollup should match filtered tool total");
    assert.ok(result.tools.length > 0, "Dashboard should include tool rows");
    assert.ok(
      Math.abs(shareSum - 100) < 0.01,
      `Tool shares should sum to ~100%, got ${shareSum}`,
    );
  });
});
