import * as assert from "node:assert";
import { claudePlanInfo, mapClaudeLimitResets, mapClaudeUsageToRateLimitInfo } from "../../shared/claudeUsage.js";

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

suite("Claude usage limit resets mapping", () => {
  test("lists usable grants soonest expiry first and sums the resets left", () => {
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    const info = mapClaudeLimitResets({
      eligible: true,
      grants: [
        { id: "grant-late", label: "Weekly reset", resets_left: 2, ends_at: "2026-12-20T00:00:00.000Z", usable_now: true },
        { id: "grant-soon", label: "5-hour reset", resets_left: 1, ends_at: "2026-12-01T00:00:00.000Z", usable_now: true },
        { id: "grant-paused", label: "Paused", resets_left: 3, paused: true },
        { id: "grant-spent", label: "Spent", resets_left: 0 },
        { id: "grant-expired", label: "Expired", resets_left: 1, ends_at: "2026-11-14T00:00:00.000Z" },
        { id: "Grant With Spaces", label: "Malformed id", resets_left: 1 },
        { id: "grant-half", label: "Fractional", resets_left: 1.5 },
        null,
      ],
    }, now);

    assert.deepStrictEqual(info, {
      availableCount: 3,
      resets: [
        { id: "grant-soon", title: "5-hour reset", expiresAtUtc: Date.parse("2026-12-01T00:00:00.000Z") },
        { id: "grant-late", title: "Weekly reset (×2)", expiresAtUtc: Date.parse("2026-12-20T00:00:00.000Z") },
      ],
    });
  });

  test("puts the server's next grant first", () => {
    const info = mapClaudeLimitResets({
      eligible: true,
      next_grant_id: "later",
      grants: [
        { id: "sooner", resets_left: 1, usable_now: true, ends_at: "2026-12-01T00:00:00.000Z" },
        { id: "later", resets_left: 1, usable_now: true, ends_at: "2026-12-20T00:00:00.000Z" },
      ],
    }, Date.parse("2026-11-15T00:00:00.000Z"));

    assert.deepStrictEqual(info?.resets?.map((reset) => reset.id), ["later", "sooner"]);
  });

  test("keeps a grant that cannot be used yet, marked so it is not offered", () => {
    const info = mapClaudeLimitResets({
      eligible: true,
      grants: [
        { id: "needs-limit", resets_left: 1, usable_now: false },
        { id: "unstated", resets_left: 1 },
      ],
    });

    assert.deepStrictEqual(info, {
      availableCount: 2,
      resets: [{ id: "needs-limit", usableNow: false }, { id: "unstated", usableNow: false }],
    });
  });

  test("shows nothing for an ineligible account or one without usable grants", () => {
    assert.strictEqual(mapClaudeLimitResets(undefined), undefined);
    assert.strictEqual(mapClaudeLimitResets(null), undefined);
    assert.strictEqual(mapClaudeLimitResets({ eligible: false, grants: [{ id: "g", resets_left: 1 }] }), undefined);
    assert.strictEqual(mapClaudeLimitResets({ eligible: true, grants: [] }), undefined);
  });

  test("flags resets withheld for an outdated Claude Code, and only that reason", () => {
    const withReason = (reason: string) => mapClaudeUsageToRateLimitInfo({
      five_hour: { utilization: 10 },
      cedar_ember: { eligible: false, ineligible_reason: reason, grants: [] },
    });

    assert.strictEqual(withReason("cli_version")?.limitResetsNeedNewerCli, true);
    assert.strictEqual(withReason("surface")?.limitResetsNeedNewerCli, undefined);
    assert.strictEqual(withReason("tier")?.limitResetsNeedNewerCli, undefined);
    assert.strictEqual(mapClaudeUsageToRateLimitInfo({ five_hour: { utilization: 10 } })?.limitResetsNeedNewerCli, undefined);
  });

  test("attaches the resets to the Claude quota", () => {
    const info = mapClaudeUsageToRateLimitInfo({
      five_hour: { utilization: 100, resets_at: "2026-12-01T05:00:00.000Z" },
      cedar_ember: { eligible: true, grants: [{ id: "grant-1", resets_left: 1, usable_now: true }] },
    });

    assert.deepStrictEqual(info?.limitResets, { availableCount: 1, resets: [{ id: "grant-1" }] });
  });
});
