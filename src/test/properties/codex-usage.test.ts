import * as assert from "node:assert";

import {
  codexPlanInfo,
  formatDurationShort,
  formatPercent,
  mapCodexLimitResetCounts,
  mapCodexLimitResets,
  mapCodexUsageToRateLimitInfo,
  nextExpiringLimitReset,
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
      windows: [
        {
          id: "codex:primary",
          label: "5h limit",
          usedPct: 17,
          resetAtUtc: 14_026_345,
          windowSeconds: undefined,
        },
        {
          id: "codex:secondary",
          label: "Weekly",
          usedPct: 3,
          resetAtUtc: 1_783_393_903_000,
          windowSeconds: undefined,
        },
      ],
    });
  });

  test("preserves dynamic Spark and Code Review quota windows", () => {
    const info = mapCodexUsageToRateLimitInfo({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      },
      code_review_rate_limit: {
        secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: 1_800_100_000 },
      },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_800_200_000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_800_300_000 },
        },
      }],
    });

    assert.deepStrictEqual(info?.windows.map((window) => ({ id: window.id, label: window.label, usedPct: window.usedPct })), [
      { id: "codex:primary", label: "5h limit", usedPct: 10 },
      { id: "code-review:secondary", label: "Code Review · Weekly", usedPct: 20 },
      { id: "additional:codex-bengalfox:primary", label: "GPT-5.3-Codex-Spark · 5h limit", usedPct: 30 },
      { id: "additional:codex-bengalfox:secondary", label: "GPT-5.3-Codex-Spark · Weekly", usedPct: 40 },
    ]);
  });

  test("does not create Spark rows when the account has no Spark quota", () => {
    const info = mapCodexUsageToRateLimitInfo({
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 20 },
      },
      additional_rate_limits: [],
    });

    assert.deepStrictEqual(info?.windows.map((window) => window.label), ["5h limit", "Weekly"]);
    assert.ok(!info?.windows.some((window) => /spark/i.test(window.label)));
  });

  test("omits additional limits that contain no usage values", () => {
    const info = mapCodexUsageToRateLimitInfo({
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: { primary_window: {} },
      }],
    });

    assert.ok(!info?.windows.some((window) => /spark/i.test(window.label)));
  });

  test("carries usage limit reset counts alongside the quota windows", () => {
    const info = mapCodexUsageToRateLimitInfo({
      rate_limit: { primary_window: { used_percent: 10 } },
      rate_limit_reset_credits: { available_count: 2 },
    });

    assert.deepStrictEqual(info?.limitResets, { availableCount: 2 });
  });

  test("omits usage limit reset counts the payload does not report", () => {
    assert.strictEqual(mapCodexLimitResetCounts({}), undefined);
    assert.strictEqual(mapCodexLimitResetCounts({ rate_limit_reset_credits: null }), undefined);
    assert.strictEqual(mapCodexLimitResetCounts({ rate_limit_reset_credits: { available_count: -1 } }), undefined);
    assert.deepStrictEqual(mapCodexLimitResetCounts({ rate_limit_reset_credits: { available_count: 0 } }), { availableCount: 0 });
    assert.deepStrictEqual(mapCodexLimitResetCounts({ rate_limit_reset_credits: { available_count: 3 } }), { availableCount: 3 });
  });

  test("lists available usage limit resets with their expiry, soonest first", () => {
    const resets = mapCodexLimitResets({
      credits: [
        { id: "reset-late", status: "available", title: "Full reset", expires_at: "2026-09-20T23:58:18.459116Z" },
        { id: "reset-soon", status: "available", title: " Full reset ", expires_at: "2026-09-02T10:00:00Z" },
        { id: "reset-used", status: "redeemed", expires_at: "2026-09-01T10:00:00Z" },
        { id: "reset-no-expiry", status: "available" },
        null,
      ],
      available_count: 3,
    });

    assert.deepStrictEqual(resets, [
      { id: "reset-soon", title: "Full reset", expiresAtUtc: Date.parse("2026-09-02T10:00:00Z") },
      { id: "reset-late", title: "Full reset", expiresAtUtc: Date.parse("2026-09-20T23:58:18.459116Z") },
      { id: "reset-no-expiry" },
    ]);
    assert.strictEqual(nextExpiringLimitReset({ availableCount: 3, resets })?.id, "reset-soon");
  });

  test("survives a reset list that is missing, empty, or unidentified", () => {
    assert.deepStrictEqual(mapCodexLimitResets({}), []);
    assert.deepStrictEqual(mapCodexLimitResets({ credits: null }), []);
    assert.deepStrictEqual(mapCodexLimitResets({ credits: [{ status: "available" }] }), []);
    assert.deepStrictEqual(
      mapCodexLimitResets({ credits: [{ id: "x", status: "available", expires_at: "not-a-date" }] }),
      [{ id: "x" }],
    );
    assert.strictEqual(nextExpiringLimitReset(undefined), undefined);
    assert.strictEqual(nextExpiringLimitReset({ availableCount: 1 }), undefined);
  });

  test("labels the ChatGPT plan of the signed-in account", () => {
    assert.deepStrictEqual(codexPlanInfo("prolite"), { id: "prolite", label: "Pro Lite" });
    assert.deepStrictEqual(codexPlanInfo(" Plus "), { id: "plus", label: "Plus" });
    assert.deepStrictEqual(codexPlanInfo("team"), { id: "team", label: "Team" });
    assert.deepStrictEqual(codexPlanInfo("future_tier"), { id: "future_tier", label: "Future Tier" });
    assert.strictEqual(codexPlanInfo(""), undefined);
    assert.strictEqual(codexPlanInfo(undefined), undefined);
  });

  test("formats compact remaining-time and percentage labels", () => {
    assert.strictEqual(formatDurationShort(14_014), "3h 53m");
    assert.strictEqual(formatDurationShort(59), "59s");
    assert.strictEqual(formatPercent(84), "84%");
    assert.strictEqual(formatPercent(12.5), "12.5%");
  });
});
