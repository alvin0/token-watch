import * as assert from "assert";

import { readableChange, summarizeTrend } from "../../webview/lib/trendData.js";
import type { Bkt } from "../../webview/lib/periodData.js";

function bucket(label: string, tokens: number): Bkt {
  return {
    key: label,
    label,
    tokens,
    cost: tokens / 10,
    turns: tokens,
    input: 0,
    output: 0,
    cache: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

suite("Usage trend data", () => {
  test("summary includes empty buckets in the average but not the active count", () => {
    const summary = summarizeTrend([bucket("Jul 9", 0), bucket("Jul 10", 10), bucket("Jul 11", 30)], "Tokens");

    assert.strictEqual(summary.total, 40);
    assert.strictEqual(summary.average, 40 / 3);
    assert.strictEqual(summary.activeCount, 2);
    assert.strictEqual(summary.peakIndex, 2);
    assert.strictEqual(summary.peakShare, 75);
  });

  test("large changes use readable multiplier wording", () => {
    assert.strictEqual(readableChange(298, 10, "Jul 10"), "29.8× higher than Jul 10");
    assert.strictEqual(readableChange(0, 0, "Jul 10"), undefined);
    assert.strictEqual(readableChange(10, 0, "Jul 10"), "Activity started after Jul 10");
  });
});
