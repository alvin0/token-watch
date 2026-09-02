import * as assert from "node:assert";

import {
  validateModelRate,
  validatePricingTable,
  validatePricingTableStrict,
} from "../../shared/pricingValidation.js";
import { mergePricingConfig } from "../../shared/pricingMerge.js";
import { PricingEngine } from "../../worker/pricing.js";

const VALID = { inputPer1K: 1, outputPer1K: 2 };

suite("Pricing validation", () => {
  test("accepts a well-formed rate", () => {
    const result = validateModelRate({ ...VALID, cachedInputPer1K: 0.5 }, "gpt-5");
    assert.deepStrictEqual(result, { inputPer1K: 1, outputPer1K: 2, cachedInputPer1K: 0.5 });
  });

  test("rejects negative rates, which would produce a negative cost", () => {
    const result = validateModelRate({ inputPer1K: -1, outputPer1K: -2 }, "gpt-5");
    assert.strictEqual(typeof result, "string");
    assert.match(result as string, /0 or greater/);
  });

  test("rejects non-numeric rates, which would produce NaN costs", () => {
    const result = validateModelRate({ inputPer1K: "oops", outputPer1K: 2 }, "gpt-5");
    assert.strictEqual(typeof result, "string");
    assert.match(result as string, /must be a number/);
  });

  test("rejects infinite rates", () => {
    assert.strictEqual(typeof validateModelRate({ inputPer1K: Infinity, outputPer1K: 2 }, "m"), "string");
    assert.strictEqual(typeof validateModelRate({ inputPer1K: Number.NaN, outputPer1K: 2 }, "m"), "string");
  });

  test("requires both an input and an output rate", () => {
    assert.strictEqual(typeof validateModelRate({ inputPer1K: 1 }, "gpt-5"), "string");
    assert.strictEqual(typeof validateModelRate({ outputPer1K: 1 }, "gpt-5"), "string");
  });

  test("rejects a rate that is not an object", () => {
    assert.strictEqual(typeof validateModelRate(3, "gpt-5"), "string");
    assert.strictEqual(typeof validateModelRate(null, "gpt-5"), "string");
    assert.strictEqual(typeof validateModelRate([1, 2], "gpt-5"), "string");
  });

  test("a table keeps good entries and reports the bad ones", () => {
    const { table, rejected } = validatePricingTable({
      good: VALID,
      negative: { inputPer1K: -1, outputPer1K: 2 },
      stringy: { inputPer1K: "oops", outputPer1K: 2 },
    });

    assert.deepStrictEqual(Object.keys(table), ["good"]);
    assert.deepStrictEqual(rejected.map((entry) => entry.model).sort(), ["negative", "stringy"]);
  });

  test("$fallback is rejected with a reason, since the merge ignores it", () => {
    const { table, rejected } = validatePricingTable({ $fallback: VALID, good: VALID });
    assert.deepStrictEqual(Object.keys(table), ["good"]);
    assert.match(rejected[0].reason, /not configurable/);
    // And the merge really does drop it, so the message is accurate.
    assert.strictEqual(mergePricingConfig({ $fallback: VALID }).audit.ignoredFallbackOverride, true);
  });

  test("strict validation reports the first problem instead of dropping it", () => {
    assert.throws(() => validatePricingTableStrict({ bad: { inputPer1K: -1, outputPer1K: 1 } }), /0 or greater/);
    assert.deepStrictEqual(validatePricingTableStrict({ good: VALID }), { good: VALID });
  });

  test("a non-object table validates to nothing rather than throwing", () => {
    assert.deepStrictEqual(validatePricingTable(null).table, {});
    assert.deepStrictEqual(validatePricingTable("nope").table, {});
    assert.deepStrictEqual(validatePricingTable([VALID]).table, {});
  });
});

suite("Pricing engine guards", () => {
  test("a validated table can never price a positive usage negatively", () => {
    // The hostile entry is dropped by validation, so it can never reach the
    // engine and turn a real usage row into a negative cost.
    const { table } = validatePricingTable({
      hostile: { inputPer1K: -5, outputPer1K: -5 },
      sane: VALID,
    });
    assert.ok(!("hostile" in table));
    const merged = mergePricingConfig(table);
    const engine = new PricingEngine(merged.table, merged.fallbackRate);

    const real = engine.costOfAggregate("sane", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    assert.ok(real.usd > 0, "A validated table must price real usage positively");
  });

  test("costs stay finite when the model is unknown", () => {
    const merged = mergePricingConfig({});
    const engine = new PricingEngine(merged.table, merged.fallbackRate);
    const cost = engine.costOfAggregate("never-heard-of-it", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
    assert.ok(Number.isFinite(cost.usd));
    assert.ok(cost.usd >= 0);
  });
});
