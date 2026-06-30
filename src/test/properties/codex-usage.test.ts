import * as assert from "node:assert";

import {
  formatDurationShort,
  formatPercent,
  mapCodexUsageToRateLimitInfo,
} from "../../shared/codexUsage.js";

suite("Codex usage mapping", () => {
  test("maps WHAM usage payloads into the protocol shape", () => {
    const info = mapCodexUsageToRateLimitInfo({
      plan_type: "team",
      rate_limit: {
        primary_window: {
          used_percent: 17,
          reset_after_seconds: 14_014,
        },
        secondary_window: {
          used_percent: 3,
          reset_at: 1_783_393_903,
        },
      },
    }, 12_345);

    assert.deepStrictEqual(info, {
      tsUtc: 12_345,
      primaryPct: 17,
      secondaryPct: 3,
      remainingSeconds: 14_014,
      weeklyResetAtUtc: 1_783_393_903_000,
    });
  });

  test("formats compact remaining-time and percentage labels", () => {
    assert.strictEqual(formatDurationShort(14_014), "3h 53m");
    assert.strictEqual(formatDurationShort(59), "59s");
    assert.strictEqual(formatPercent(84), "84%");
    assert.strictEqual(formatPercent(12.5), "12.5%");
  });
});
