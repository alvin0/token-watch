import * as assert from "node:assert";
import { buildProviderQuotaLayout } from "../../webview/quotaGroups.js";

suite("Provider quota grouping", () => {
  test("keeps Codex primary quotas visible and groups Spark without duplication", () => {
    const layout = buildProviderQuotaLayout("codex", [
      { id: "codex:primary", label: "5h limit", usedPct: 14 },
      { id: "codex:secondary", label: "Weekly", usedPct: 7 },
      { id: "additional:spark:primary", label: "GPT-5.3-Codex-Spark · 5h limit", usedPct: 0 },
      { id: "additional:spark:secondary", label: "GPT-5.3-Codex-Spark · Weekly", usedPct: 0 },
    ]);

    assert.deepStrictEqual(layout.primaryWindows.map((window) => window.id), ["codex:primary", "codex:secondary"]);
    assert.strictEqual(layout.additionalGroups.length, 1);
    assert.strictEqual(layout.additionalGroups[0].name, "GPT-5.3-Codex-Spark");
    assert.deepStrictEqual(layout.additionalGroups[0].windows.map((window) => window.id), [
      "additional:spark:primary",
      "additional:spark:secondary",
    ]);
    assert.strictEqual(layout.additionalLimitCount, 2);
    assert.strictEqual(layout.collapsedSummary, "GPT-5.3-Codex-Spark · 2 limits");
  });

  test("keeps Claude primary quotas visible and groups Fable", () => {
    const layout = buildProviderQuotaLayout("claude", [
      { id: "session", label: "5h limit", usedPct: 0 },
      { id: "weekly", label: "Weekly", usedPct: 0 },
      { id: "weekly:model:fable", label: "Fable · Weekly", usedPct: 0 },
    ]);

    assert.deepStrictEqual(layout.primaryWindows.map((window) => window.id), ["session", "weekly"]);
    assert.strictEqual(layout.additionalGroups[0].name, "Fable");
    assert.strictEqual(layout.additionalLimitCount, 1);
    assert.strictEqual(layout.collapsedSummary, "Fable · 1 additional limit");
  });

  test("summarizes multiple additional groups by total visible limits", () => {
    const layout = buildProviderQuotaLayout("codex", [
      { id: "codex:primary", label: "5h limit", usedPct: 10 },
      { id: "spark:primary", label: "Spark · 5h limit", usedPct: 20 },
      { id: "spark:secondary", label: "Spark · Weekly", usedPct: 30 },
      { id: "review:secondary", label: "Code Review · Weekly", usedPct: 40 },
      { id: "empty", label: "Unavailable · Weekly" },
    ]);

    assert.strictEqual(layout.additionalGroups.length, 2);
    assert.strictEqual(layout.additionalLimitCount, 3);
    assert.strictEqual(layout.collapsedSummary, "3 additional limits");
  });

  test("does not expose an expand summary when no additional quota exists", () => {
    const layout = buildProviderQuotaLayout("claude", [
      { id: "session", label: "5h limit", usedPct: 10 },
      { id: "weekly", label: "Weekly", usedPct: 20 },
    ]);

    assert.strictEqual(layout.additionalLimitCount, 0);
    assert.strictEqual(layout.collapsedSummary, undefined);
  });
});
