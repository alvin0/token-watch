import * as assert from "node:assert";
import { formatModelCost } from "../../webview/modelCost.js";
import { formatEffortLabel, sortModelUsage, type SortableModelUsage } from "../../webview/modelUsage.js";
import { summarizeModels } from "../../shared/modelSummary.js";
import type { DailyAggregate } from "../../shared/storeTypes.js";

suite("Top models cost display", () => {
  test("shows the priced model cost", () => {
    assert.strictEqual(formatModelCost(6.56, 0, 83), "$6.56");
  });

  test("marks a partially priced model cost", () => {
    assert.strictEqual(formatModelCost(1.25, 2, 10), "$1.25+");
  });

  test("does not show a misleading zero when all turns have unknown pricing", () => {
    assert.strictEqual(formatModelCost(0, 3, 3), "—");
  });

  test("sorts the full model table by tokens, cost, turns, and token share", () => {
    const rows: SortableModelUsage[] = [
      model("alpha", 100, 5, 2, 10),
      model("beta", 300, 1, 8, 30),
      model("gamma", 200, 9, 4, 20),
    ];

    assert.deepStrictEqual(sortModelUsage(rows, "tokens", "desc").map((row) => row.id), ["beta", "gamma", "alpha"]);
    assert.deepStrictEqual(sortModelUsage(rows, "cost", "desc").map((row) => row.id), ["beta", "gamma", "alpha"]);
    assert.deepStrictEqual(sortModelUsage(rows, "turns", "desc").map((row) => row.id), ["gamma", "alpha", "beta"]);
    assert.deepStrictEqual(sortModelUsage(rows, "share", "asc").map((row) => row.id), ["alpha", "gamma", "beta"]);
  });

  test("formats Codex reasoning levels including Ultra", () => {
    assert.strictEqual(formatEffortLabel("low"), "Light");
    assert.strictEqual(formatEffortLabel("xhigh"), "Extra High");
    assert.strictEqual(formatEffortLabel("ultra"), "Ultra");
    assert.strictEqual(formatEffortLabel("max"), "Max");
  });
});

function model(id: string, total: number, turns: number, cost: number, share: number): SortableModelUsage {
  return { id, total, turns, cost, share };
}

function dailyRow(overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return {
    day: "2026-06-03",
    source: "codex",
    variantId: "gpt-5",
    baseModel: "gpt-5",
    workspace: "/repo-a",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
    reasoningTokens: 5,
    totalTokens: 105,
    turns: 1,
    costUsd: 0.5,
    unknownCostTurns: 0,
    ...overrides,
  };
}

suite("Model roll-up", () => {
  test("merges one model across workspaces into a single row", () => {
    const summaries = summarizeModels([
      dailyRow({ workspace: "/repo-a" }),
      dailyRow({ workspace: "/repo-b" }),
    ]);

    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].workspaces, 2);
    assert.strictEqual(summaries[0].turns, 2);
    assert.strictEqual(summaries[0].total, 210);
  });

  test("keeps Codex and Claude apart when they share a model id", () => {
    const summaries = summarizeModels([
      dailyRow({ source: "codex" }),
      dailyRow({ source: "claude" }),
    ]);

    assert.strictEqual(summaries.length, 2);
    assert.deepStrictEqual(
      summaries.map((row) => row.id).sort(),
      ["claude:gpt-5", "codex:gpt-5"],
    );
  });

  test("the component breakdown adds up to the reported total", () => {
    const [summary] = summarizeModels([dailyRow()]);
    assert.strictEqual(
      summary.input + summary.output + summary.cacheRead + summary.cacheWrite + summary.reasoning,
      summary.metrics.breakdownTotal,
    );
    assert.strictEqual(summary.metrics.breakdownTotal, 105);
  });

  test("cache creation is a miss, not a hit", () => {
    const [summary] = summarizeModels([dailyRow()]);
    // read 30 of (input 10 + read 30 + write 40) = 42.857%
    assert.ok(Math.abs(summary.metrics.cacheHitPct - (30 / 80) * 100) < 1e-9);
  });
});
