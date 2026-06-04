import * as assert from "assert";

import { currentRangeForPeriod, makeBuckets, pRange } from "../../webview/lib/periodData.js";

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
