import * as assert from "assert";

import { currentRangeForPeriod, makeBuckets, pRange, previousPeriodAnchor } from "../../webview/lib/periodData.js";
import { localDay } from "../../shared/time.js";

suite("Webview period windows", () => {
  test("pRange uses the requested rolling comparison windows", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0);

    assert.deepStrictEqual(pRange("today", now), {
      from: "2026-06-03",
      to: "2026-06-03",
      prevFrom: "2026-06-02",
      prevTo: "2026-06-02",
      bucketCount: 1,
    });

    assert.deepStrictEqual(pRange("day", now), {
      from: "2026-05-28",
      to: "2026-06-03",
      prevFrom: "2026-05-21",
      prevTo: "2026-05-27",
      bucketCount: 7,
    });

    assert.deepStrictEqual(pRange("week", now), {
      from: "2026-04-20",
      to: "2026-06-03",
      prevFrom: "2026-03-02",
      prevTo: "2026-04-19",
      bucketCount: 7,
    });

    assert.deepStrictEqual(pRange("month", now), {
      from: "2026-01-01",
      to: "2026-06-03",
      prevFrom: "2025-07-01",
      prevTo: "2025-12-31",
      bucketCount: 6,
    });

    assert.deepStrictEqual(pRange("year", now), {
      from: "2025-01-01",
      to: "2026-06-03",
      prevFrom: "2023-01-01",
      prevTo: "2024-12-31",
      bucketCount: 2,
    });
  });

  test("makeBuckets returns the visible bucket count for each tab", () => {
    assert.strictEqual(makeBuckets([], "today").length, 1);
    assert.strictEqual(makeBuckets([], "day").length, 7);
    assert.strictEqual(makeBuckets([], "week").length, 7);
    assert.strictEqual(makeBuckets([], "month").length, 6);
    assert.strictEqual(makeBuckets([], "year").length, 2);
  });

  test("previousPeriodAnchor aligns each comparison window", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0);

    assert.strictEqual(localDay(previousPeriodAnchor("day", now)), "2026-05-27");
    assert.strictEqual(localDay(previousPeriodAnchor("week", now)), "2026-04-15");
    assert.strictEqual(localDay(previousPeriodAnchor("month", now)), "2025-12-03");
    assert.strictEqual(localDay(previousPeriodAnchor("year", now)), "2024-06-03");
  });

  test("makeBuckets preserves cache-read and cache-write breakdowns", () => {
    const day = localDay(new Date());
    const buckets = makeBuckets([{
      day,
      source: "claude",
      variantId: "claude-opus-4.7",
      baseModel: "claude-opus-4.7",
      workspace: "",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      reasoningTokens: 0,
      totalTokens: 100,
      turns: 1,
      costUsd: 0.5,
      unknownCostTurns: 0,
    }], "day");

    assert.strictEqual(buckets[0].cache, 30);
    assert.strictEqual(buckets[0].cacheWrite, 40);
  });

  test("currentRangeForPeriod returns the active visible period", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0);

    assert.deepStrictEqual(currentRangeForPeriod("day", now), {
      from: "2026-06-03",
      to: "2026-06-03",
    });
    assert.deepStrictEqual(currentRangeForPeriod("week", now), {
      from: "2026-06-01",
      to: "2026-06-03",
    });
    assert.deepStrictEqual(currentRangeForPeriod("month", now), {
      from: "2026-06-01",
      to: "2026-06-03",
    });
    assert.deepStrictEqual(currentRangeForPeriod("year", now), {
      from: "2026-01-01",
      to: "2026-06-03",
    });
  });
});
