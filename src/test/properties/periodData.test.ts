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

suite("Webview period windows across DST", () => {
  // These dates put a DST boundary inside the rolling window. With fixed 24h
  // arithmetic the boundaries land an hour short and report the previous day.
  const dstCases = [
    { label: "spring forward (northern)", now: new Date(2026, 2, 25, 12, 0, 0) },
    { label: "fall back (northern)", now: new Date(2026, 10, 5, 12, 0, 0) },
    { label: "spring forward (southern)", now: new Date(2026, 9, 8, 12, 0, 0) },
  ];

  for (const { label, now } of dstCases) {
    test(`pRange keeps whole calendar days — ${label}`, () => {
      const today = localDay(now);

      const day = pRange("day", now);
      assert.strictEqual(day.to, today);
      assert.strictEqual(day.from, expectedShift(now, -6));
      assert.strictEqual(day.prevFrom, expectedShift(now, -13));
      assert.strictEqual(day.prevTo, expectedShift(now, -7));

      const today0 = pRange("today", now);
      assert.strictEqual(today0.prevFrom, expectedShift(now, -1));

      const week = pRange("week", now);
      // The window start is a Monday and prevTo is the day before it.
      assert.strictEqual(weekdayOf(week.from), 1);
      assert.strictEqual(weekdayOf(week.prevFrom), 1);
      assert.strictEqual(week.prevTo, shiftDayString(week.from, -1));

      const month = pRange("month", now);
      assert.ok(month.from.endsWith("-01"));
      assert.strictEqual(month.prevTo, shiftDayString(month.from, -1));
    });
  }

  test("makeBuckets emits 7 distinct calendar days across a DST boundary", () => {
    const buckets = makeBuckets([], "day", new Date(2026, 2, 25, 12, 0, 0));
    assert.strictEqual(buckets.length, 7);
    assert.strictEqual(new Set(buckets.map((bucket) => bucket.key)).size, 7);
  });

  test("previousPeriodAnchor lands on the same wall-clock day-of-week", () => {
    const now = new Date(2026, 2, 25, 12, 0, 0);
    assert.strictEqual(previousPeriodAnchor("day", now).getDay(), now.getDay());
    assert.strictEqual(previousPeriodAnchor("week", now).getDay(), now.getDay());
  });
});

function expectedShift(now: Date, days: number): string {
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

function shiftDayString(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDay(new Date(year, month - 1, date + amount));
}

function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getDay();
}
