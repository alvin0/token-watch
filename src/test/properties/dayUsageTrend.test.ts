import * as assert from "assert";
import { recentLocalDays } from "../../webview/lib/dayUsageTrend.js";

suite("Day usage trend navigation", () => {
  test("returns seven local calendar days ending today", () => {
    assert.deepStrictEqual(recentLocalDays(new Date(2026, 6, 12, 23, 30), 7), [
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
  });

  test("crosses month boundaries without skipping a day", () => {
    assert.deepStrictEqual(recentLocalDays(new Date(2026, 2, 2, 1, 0), 4), [
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });
});
