import * as assert from "node:assert";

import {
  ANOMALY_MIN_SAMPLES,
  detectCostAnomalies,
  highContextSessions,
} from "../../shared/analyticsFlags.js";
import { deriveTokenMetrics, sumTokenComponents } from "../../shared/tokenMetrics.js";
import type { DailyAggregate, SessionAggregate } from "../../shared/storeTypes.js";

function day(dayString: string, costUsd: number): DailyAggregate {
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

function session(peakContextFill: number | undefined, sessionId: string): SessionAggregate {
  return {
    source: "claude",
    sessionId,
    workspace: "/repo",
    firstTsUtc: 0,
    lastTsUtc: 1,
    turns: 1,
    totalTokens: 1000,
    costUsd: 1,
    sidechainTokens: 0,
    ...(peakContextFill === undefined ? {} : { peakContextFill }),
  };
}

suite("Cost anomaly detection", () => {
  test("flags a day well above the trailing median", () => {
    const series = [
      ...Array.from({ length: 10 }, (_unused, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 1)),
      day("2026-06-11", 10),
    ];
    const anomalies = detectCostAnomalies(series, 2);
    assert.deepStrictEqual(anomalies.map((anomaly) => anomaly.day), ["2026-06-11"]);
    assert.strictEqual(anomalies[0].medianUsd, 1);
    assert.strictEqual(anomalies[0].ratio, 10);
  });

  test("respects the configured multiplier", () => {
    const series = [
      ...Array.from({ length: 10 }, (_unused, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 1)),
      day("2026-06-11", 3),
    ];
    assert.strictEqual(detectCostAnomalies(series, 2).length, 1, "3x the median trips a 2x threshold");
    assert.strictEqual(detectCostAnomalies(series, 5).length, 0, "3x the median does not trip a 5x threshold");
  });

  test("says nothing until there is enough history to have a median", () => {
    const series = Array.from(
      { length: ANOMALY_MIN_SAMPLES },
      (_unused, index) => day(`2026-06-0${index + 1}`, index === ANOMALY_MIN_SAMPLES - 1 ? 100 : 1),
    );
    assert.deepStrictEqual(detectCostAnomalies(series.slice(0, 2), 2), []);
  });

  test("judges a day against the days before it, not including itself", () => {
    const series = [
      ...Array.from({ length: 10 }, (_unused, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 1)),
      day("2026-06-11", 50),
      day("2026-06-12", 50),
    ];
    const anomalies = detectCostAnomalies(series, 2);
    assert.ok(
      anomalies.some((anomaly) => anomaly.day === "2026-06-11"),
      "The first spike is measured against the quiet run before it",
    );
  });

  test("a non-positive multiplier disables the check", () => {
    const series = Array.from({ length: 10 }, (_unused, index) => day(`2026-06-0${index}`, index === 9 ? 100 : 1));
    assert.deepStrictEqual(detectCostAnomalies(series, 0), []);
    assert.deepStrictEqual(detectCostAnomalies(series, Number.NaN), []);
  });

  test("sums a day's cost across sources and models before judging it", () => {
    const series = [
      ...Array.from({ length: 10 }, (_unused, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 1)),
      day("2026-06-11", 2),
      { ...day("2026-06-11", 3), source: "claude" as const },
    ];
    assert.strictEqual(detectCostAnomalies(series, 2)[0]?.ratio, 5);
  });
});

suite("Context fill threshold", () => {
  test("returns sessions at or above the configured percentage, worst first", () => {
    const sessions = [session(0.5, "a"), session(0.95, "b"), session(0.82, "c")];
    const flagged = highContextSessions(sessions, 80);
    assert.deepStrictEqual(flagged.map((entry) => entry.sessionId), ["b", "c"]);
    assert.ok(Math.abs(flagged[0].peakFillPct - 95) < 1e-9);
  });

  test("sessions with no recorded fill are not flagged", () => {
    assert.deepStrictEqual(highContextSessions([session(undefined, "a")], 1), []);
  });

  test("a non-positive threshold disables the check", () => {
    assert.deepStrictEqual(highContextSessions([session(0.99, "a")], 0), []);
  });
});

suite("Token metrics", () => {
  test("the five components always sum to the breakdown total", () => {
    const metrics = deriveTokenMetrics({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheCreationTokens: 8,
      reasoningTokens: 16,
    });
    assert.strictEqual(metrics.breakdownTotal, 31);
    assert.strictEqual(
      metrics.input + metrics.output + metrics.cacheRead + metrics.cacheWrite + metrics.reasoning,
      metrics.breakdownTotal,
    );
  });

  test("cache creation is a miss: it lowers the hit rate rather than raising it", () => {
    const warm = deriveTokenMetrics({ inputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 0 });
    const cold = deriveTokenMetrics({ inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 90 });
    assert.ok(Math.abs(warm.cacheHitPct - 90) < 1e-9);
    assert.strictEqual(cold.cacheHitPct, 0, "A cache that was only written to has hit nothing");
  });

  test("an empty input is all zeroes rather than NaN", () => {
    const metrics = deriveTokenMetrics();
    assert.strictEqual(metrics.total, 0);
    assert.strictEqual(metrics.cacheHitPct, 0);
  });

  test("non-finite fields are treated as zero", () => {
    const metrics = deriveTokenMetrics({ inputTokens: Number.NaN, outputTokens: 5 });
    assert.strictEqual(metrics.breakdownTotal, 5);
  });

  test("sumTokenComponents keeps every field", () => {
    const total = sumTokenComponents([
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, reasoningTokens: 5, totalTokens: 15 },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, reasoningTokens: 5, totalTokens: 15 },
    ]);
    assert.deepStrictEqual(total, {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 8,
      reasoningTokens: 10,
      totalTokens: 30,
    });
  });
});


suite("Cost anomaly window is calendar days", () => {
  test("idle days count towards the baseline instead of being skipped", () => {
    // A fortnight that is mostly idle with a few small days, then a big one.
    // Judged against the last 14 CALENDAR days the big day is a clear spike;
    // judged against "the last 14 days that had rows" the idle days vanish and
    // the baseline is the small days alone, which hides it.
    const series = [
      day("2026-06-01", 1),
      day("2026-06-02", 1),
      day("2026-06-03", 1),
      day("2026-06-04", 1),
      day("2026-06-05", 1),
      day("2026-06-06", 1),
      // 7th-19th idle.
      day("2026-06-20", 8),
    ];

    const anomalies = detectCostAnomalies(series, 2);
    assert.deepStrictEqual(
      anomalies.map((anomaly) => anomaly.day),
      ["2026-06-20"],
      "A spike after a mostly-idle fortnight must be flagged",
    );
    assert.ok(
      anomalies[0].medianUsd > 0 && anomalies[0].medianUsd < 1,
      `The baseline should be dragged down by the idle days, got ${anomalies[0].medianUsd}`,
    );
    assert.ok(Number.isFinite(anomalies[0].ratio));
  });

  test("a completely idle window gives no baseline, so nothing is claimed", () => {
    // Six active days, then a month of nothing, then activity resumes. There is
    // no meaningful multiple of zero, so this is reported as nothing rather
    // than as an infinite spike.
    const series = [
      ...["01", "02", "03", "04", "05", "06"].map((d) => day(`2026-06-${d}`, 10)),
      day("2026-07-20", 10),
    ];
    const anomalies = detectCostAnomalies(series, 2);
    assert.ok(
      anomalies.every((anomaly) => Number.isFinite(anomaly.ratio)),
      "No anomaly may carry an infinite ratio",
    );
    assert.ok(!anomalies.some((anomaly) => anomaly.day === "2026-07-20"));
  });

  test("a quiet day is never itself reported as an anomaly", () => {
    const series = [
      ...Array.from({ length: 10 }, (_unused, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 5)),
      day("2026-06-20", 0),
    ];
    assert.ok(
      !detectCostAnomalies(series, 2).some((anomaly) => anomaly.day === "2026-06-20"),
      "Spending nothing is not an anomaly",
    );
  });

  test("the window never reaches back before the first observed day", () => {
    // Only three days of history: too few samples, so nothing is claimed.
    const series = [day("2026-06-01", 1), day("2026-06-02", 1), day("2026-06-03", 50)];
    assert.deepStrictEqual(detectCostAnomalies(series, 2), []);
  });

  test("a long gap does not drag ancient activity into the window", () => {
    const series = [
      ...Array.from({ length: 20 }, (_unused, index) => day(`2026-01-${String(index + 1).padStart(2, "0")}`, 100)),
      // Six months later, a modest day.
      day("2026-07-01", 1),
    ];
    const anomalies = detectCostAnomalies(series, 2);
    assert.ok(
      !anomalies.some((anomaly) => anomaly.day === "2026-07-01"),
      "A cheap day after a long gap is not an anomaly, whatever happened months ago",
    );
  });
});
