import * as assert from "node:assert";

import {
  BASELINE_HISTORY_DAYS,
  visibleRangeForPeriod,
  makeBuckets,
  previousPeriodAnchor,
  pRange,
  queryRangeForPeriod,
} from "../../webview/lib/periodData.js";
import { readableChange } from "../../webview/lib/trendData.js";
import { detectCostAnomalies, ANOMALY_MIN_SAMPLES } from "../../shared/analyticsFlags.js";
import { localDay } from "../../shared/time.js";
import type { DailyAggregate } from "../../shared/storeTypes.js";

function day(dayString: string, costUsd = 1): DailyAggregate {
  return {
    day: dayString,
    source: "codex",
    variantId: "gpt-5",
    baseModel: "gpt-5",
    workspace: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 1,
    costUsd,
    unknownCostTurns: 0,
  };
}

suite("Comparison window alignment", () => {
  test("the previous six-month window does not skip a month on the 31st", () => {
    // 31 Mar: `new Date(y, m - 6, 31)` targets September, which has 30 days,
    // so it rolled into 1 October and shifted every bucket by one.
    const anchor = previousPeriodAnchor("month", new Date(2026, 2, 31, 12, 0, 0));
    assert.strictEqual(anchor.getMonth(), 8, "Should land in September");
    assert.strictEqual(anchor.getFullYear(), 2025);

    const buckets = makeBuckets([], "month", anchor);
    const keys = buckets.map((bucket) => bucket.key).sort();
    assert.deepStrictEqual(
      keys,
      ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09"],
      "The previous window should be Apr–Sep, not May–Oct",
    );
  });

  test("every month-end anchors inside the intended month", () => {
    for (const month of [0, 2, 4, 6, 7, 9, 11]) {
      const source = new Date(2026, month, 31, 12, 0, 0);
      if (source.getMonth() !== month) { continue; }
      const anchor = previousPeriodAnchor("month", source);
      const expectedMonth = (month + 12 - 6) % 12;
      assert.strictEqual(
        anchor.getMonth(),
        expectedMonth,
        `31 ${month + 1} should anchor six months back, got month ${anchor.getMonth() + 1}`,
      );
    }
  });

  test("the two-year anchor survives a leap day", () => {
    const anchor = previousPeriodAnchor("year", new Date(2028, 1, 29, 12, 0, 0));
    assert.strictEqual(anchor.getFullYear(), 2026);
    assert.strictEqual(anchor.getMonth(), 1, "Should stay in February");
    assert.strictEqual(anchor.getDate(), 28, "Clamped to the last day of a non-leap February");
  });
});

suite("Baseline history in the query window", () => {
  test("the Today tab fetches enough history for a trailing median", () => {
    const range = queryRangeForPeriod("today");
    const spanDays = (Date.now() - range.fromUtc) / (24 * 60 * 60 * 1000);
    assert.ok(
      spanDays >= ANOMALY_MIN_SAMPLES,
      `Today should fetch at least ${ANOMALY_MIN_SAMPLES} days of history, got ${spanDays.toFixed(1)}`,
    );
    assert.ok(spanDays >= BASELINE_HISTORY_DAYS);
  });

  test("every tab keeps at least its own comparison window", () => {
    for (const period of ["today", "day", "week", "month", "year"] as const) {
      const range = queryRangeForPeriod(period);
      const { prevFrom } = pRange(period);
      const prevFromMs = new Date(`${prevFrom}T00:00:00`).getTime();
      assert.ok(
        range.fromUtc <= prevFromMs,
        `${period}: the query must still cover its own previous window`,
      );
    }
  });

  test("with that history the anomaly detector can actually fire on today", () => {
    // Build the series a Today query would now return: a quiet run, then a spike.
    const today = new Date();
    const series: DailyAggregate[] = [];
    for (let offset = BASELINE_HISTORY_DAYS; offset > 0; offset--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      series.push(day(localDay(d), 1));
    }
    series.push(day(localDay(today), 20));

    const anomalies = detectCostAnomalies(series, 2);
    assert.ok(
      anomalies.some((anomaly) => anomaly.day === localDay(today)),
      "Today's spike should be flagged once the query carries a baseline",
    );
  });
});

suite("Readable change wording", () => {
  test("dropping to zero does not print Infinity", () => {
    const message = readableChange(0, 10, "last week");
    assert.ok(message, "A drop to zero is worth describing");
    assert.ok(!/Infinity/.test(message), `Got: ${message}`);
    assert.match(message, /last week/);
  });

  test("rising from zero is still described as a start", () => {
    assert.match(readableChange(10, 0, "last week") ?? "", /last week/);
  });

  test("two zeroes say nothing", () => {
    assert.strictEqual(readableChange(0, 0, "last week"), undefined);
  });

  test("ordinary ratios keep their multiplier wording finite", () => {
    for (const [current, previous] of [[10, 1], [1, 10], [3, 2], [2, 3]]) {
      const message = readableChange(current, previous, "last week") ?? "";
      assert.ok(!/Infinity|NaN/.test(message), `${current} vs ${previous} → ${message}`);
    }
  });
});


suite("Visible window versus baseline window", () => {
  test("the visible window is only the selected period", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0);
    const visible = visibleRangeForPeriod("today", now);
    assert.strictEqual(
      localDay(new Date(visible.fromUtc)),
      localDay(now),
      "Today's visible window starts today, not at the comparison or baseline day",
    );
  });

  test("the read range reaches further back than the visible one", () => {
    for (const period of ["today", "day", "week", "month", "year"] as const) {
      const read = queryRangeForPeriod(period);
      const visible = visibleRangeForPeriod(period);
      assert.ok(
        read.fromUtc <= visible.fromUtc,
        `${period}: the read range must cover at least the visible window`,
      );
    }
    // And for Today the difference is real: that gap is the baseline that makes
    // the anomaly detector usable, and precisely what must NOT reach the tool
    // table or the session lists.
    const readToday = queryRangeForPeriod("today");
    const visibleToday = visibleRangeForPeriod("today");
    const gapDays = (visibleToday.fromUtc - readToday.fromUtc) / (24 * 60 * 60 * 1000);
    assert.ok(gapDays >= BASELINE_HISTORY_DAYS - 1, `Expected a baseline gap, got ${gapDays.toFixed(1)} days`);
  });

  test("each period's visible window starts on its own first day", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0);
    for (const period of ["today", "day", "week", "month", "year"] as const) {
      const visible = visibleRangeForPeriod(period, now);
      assert.strictEqual(
        localDay(new Date(visible.fromUtc)),
        pRange(period, now).from,
        `${period}: the visible window should start at the period's first day`,
      );
    }
  });
});
