import * as assert from "node:assert";
import { formatModelCost } from "../../webview/modelCost.js";
import { formatEffortLabel, sortModelUsage, type ModelUsageSummary } from "../../webview/modelUsage.js";

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
    const rows: ModelUsageSummary[] = [
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

function model(id: string, total: number, turns: number, cost: number, share: number): ModelUsageSummary {
  return {
    id,
    model: id,
    source: "codex",
    effort: "medium",
    input: total,
    output: 0,
    cache: 0,
    reasoning: 0,
    turns,
    cost,
    unknownCostTurns: 0,
    total,
    share,
  };
}
