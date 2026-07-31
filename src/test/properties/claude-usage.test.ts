import * as assert from "node:assert";
import { claudePlanInfo, mapClaudeUsageToRateLimitInfo } from "../../shared/claudeUsage.js";

suite("Claude usage mapping", () => {
  test("maps Claude Code five-hour and weekly quota windows", () => {
    const info = mapClaudeUsageToRateLimitInfo({
      five_hour: {
        utilization: 12.5,
        resets_at: "2026-07-10T20:10:00.000Z",
      },
      seven_day: {
        utilization: 34,
        resets_at: "2026-07-11T23:00:00.000Z",
      },
      limits: [{
        kind: "weekly_scoped",
        group: "weekly",
        percent: 56,
        resets_at: "2026-07-12T23:00:00.000Z",
        is_active: false,
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      }],
    }, 12_345);

    assert.deepStrictEqual(info, {
      tsUtc: 12_345,
      fiveHourPct: 12.5,
      weeklyPct: 34,
      fiveHourResetAtUtc: Date.parse("2026-07-10T20:10:00.000Z"),
      weeklyResetAtUtc: Date.parse("2026-07-11T23:00:00.000Z"),
      windows: [
        {
          id: "session",
          label: "5h limit",
          usedPct: 12.5,
          resetAtUtc: Date.parse("2026-07-10T20:10:00.000Z"),
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 34,
          resetAtUtc: Date.parse("2026-07-11T23:00:00.000Z"),
        },
        {
          id: "weekly:model:fable",
          label: "Fable · Weekly",
          usedPct: 56,
          resetAtUtc: Date.parse("2026-07-12T23:00:00.000Z"),
          isActive: false,
        },
      ],
    });
  });

  test("discovers legacy and unknown future top-level usage windows", () => {
    const info = mapClaudeUsageToRateLimitInfo({
      seven_day_opus: { utilization: 11, resets_at: "2026-07-12T00:00:00Z" },
      seven_day_overage_included: { utilization: 22, resets_at: "2026-07-13T00:00:00Z" },
      nimbus_quill: { utilization: 33, resets_at: "2026-07-14T00:00:00Z" },
    });

    assert.deepStrictEqual(info?.windows.map((window) => ({ id: window.id, label: window.label })), [
      { id: "weekly:model:opus", label: "Opus · Weekly" },
      { id: "weekly:model:fable", label: "Fable 5 · Weekly" },
      { id: "dynamic:nimbus-quill", label: "Nimbus Quill" },
    ]);
  });

  test("returns undefined when no quota windows are present", () => {
    assert.strictEqual(mapClaudeUsageToRateLimitInfo({}), undefined);
  });

  test("does not create Fable rows when the account has no Fable quota", () => {
    const info = mapClaudeUsageToRateLimitInfo({
      five_hour: { utilization: 10 },
      seven_day: { utilization: 20 },
      limits: [],
    });

    assert.deepStrictEqual(info?.windows.map((window) => window.label), ["5h limit", "Weekly"]);
    assert.ok(!info?.windows.some((window) => /fable/i.test(window.label)));
  });

  test("labels the subscription plan of the signed-in account", () => {
    assert.deepStrictEqual(claudePlanInfo("team"), { id: "team", label: "Team" });
    assert.deepStrictEqual(claudePlanInfo("max_20x"), { id: "max_20x", label: "Max 20×" });
    assert.deepStrictEqual(claudePlanInfo(" Pro "), { id: "pro", label: "Pro" });
    assert.deepStrictEqual(claudePlanInfo("future_tier"), { id: "future_tier", label: "Future Tier" });
    assert.strictEqual(claudePlanInfo(""), undefined);
    assert.strictEqual(claudePlanInfo(undefined), undefined);
  });

  test("omits scoped limits that contain no usage values", () => {
    const info = mapClaudeUsageToRateLimitInfo({
      five_hour: { utilization: 10 },
      limits: [{
        kind: "weekly_scoped",
        group: "weekly",
        scope: { model: { display_name: "Fable" } },
      }],
    });

    assert.ok(!info?.windows.some((window) => /fable/i.test(window.label)));
  });
});
