import * as assert from "node:assert";
import { formatCostPerTurn } from "../../webview/format.js";

suite("Today summary card", () => {
  test("keeps useful precision for sub-dollar cost per turn", () => {
    assert.strictEqual(formatCostPerTurn(0.0914), "$0.091");
  });

  test("uses normal currency precision for larger values", () => {
    assert.strictEqual(formatCostPerTurn(1.256), "$1.26");
  });
});
