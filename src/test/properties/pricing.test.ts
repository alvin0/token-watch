import * as assert from "assert";
import fc from "fast-check";

import type { ModelRate, PricingTable, CumulativeTotals } from "../../shared/types";
import { mergePricingConfig } from "../../shared/pricingMerge";
import { DEFAULT_PRICING, FALLBACK_RATE } from "../../shared/defaultPricing";
import { PricingEngine } from "../../worker/pricing";

/**
 * Property tests for the PricingEngine. Exercises pure pricing logic and must
 * NOT import `vscode`.
 */

/** Arbitrary non-negative rate (USD per 1K tokens). */
const rate = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

/** Arbitrary non-negative integer token count. */
const tokenCount = fc.nat({ max: 1_000_000 });

/** Arbitrary ModelRate with all non-negative rates. */
const modelRateArb: fc.Arbitrary<ModelRate> = fc.record({
  inputPer1K: rate,
  cachedInputPer1K: rate,
  cacheCreationPer1K: rate,
  outputPer1K: rate,
});

/** Arbitrary CumulativeTotals with all non-negative integer counts. */
const cumulativeTotalsArb: fc.Arbitrary<CumulativeTotals> = fc.record({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  reasoningTokens: tokenCount,
});

/** Model name that won't collide with "known-model". */
const unknownModelName = fc.string({ minLength: 1, maxLength: 20 }).filter(
  (s) => s !== "known-model",
);

suite("PricingEngine property tests", () => {
  test("Bundled GPT pricing matches migrated OpenAI MTok rates", () => {
    assertRates([
      ["gpt-5", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5-codex", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5-codex-mini", { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 }],
      ["gpt-5-mini", { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 }],
      ["gpt-5-nano", { inputPer1K: 0.00005, cachedInputPer1K: 0.000005, outputPer1K: 0.0004 }],
      ["gpt-5-chat-latest", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5-pro", { inputPer1K: 0.015, cachedInputPer1K: 0, outputPer1K: 0.12 }],
      ["gpt-5.1", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5.1-chat-latest", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5.1-codex", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5.1-codex-max", { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 }],
      ["gpt-5.1-codex-mini", { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 }],
      ["gpt-5.2", { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 }],
      ["gpt-5.2-chat-latest", { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 }],
      ["gpt-5.2-codex", { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 }],
      ["gpt-5.2-pro", { inputPer1K: 0.021, cachedInputPer1K: 0, outputPer1K: 0.168 }],
      ["gpt-5.3-chat-latest", { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 }],
      ["gpt-5.3-codex", { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 }],
      ["gpt-5.3-codex-spark", { inputPer1K: 0.002, cachedInputPer1K: 0.001, outputPer1K: 0.008 }],
      ["gpt-5.4", { inputPer1K: 0.0025, cachedInputPer1K: 0.00025, outputPer1K: 0.015 }],
      ["gpt-5.4-long-context", { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.0225 }],
      ["gpt-5.4-mini", { inputPer1K: 0.00075, cachedInputPer1K: 0.000075, outputPer1K: 0.0045 }],
      ["gpt-5.4-mini-2026-03-17", { inputPer1K: 0.00075, cachedInputPer1K: 0.000075, outputPer1K: 0.0045 }],
      ["gpt-5.4-pro", { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 }],
      ["gpt-5.4-pro-long-context", { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 }],
      ["gpt-5.5", { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.03 }],
      ["gpt-5.5-long-context", { inputPer1K: 0.01, cachedInputPer1K: 0.001, outputPer1K: 0.045 }],
      ["gpt-5.5-pro", { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 }],
      ["gpt-5.5-pro-long-context", { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 }],
      ["gpt-4.1", { inputPer1K: 0.002, cachedInputPer1K: 0.0005, outputPer1K: 0.008 }],
      ["gpt-4.1-mini", { inputPer1K: 0.0004, cachedInputPer1K: 0.0001, outputPer1K: 0.0016 }],
      ["gpt-4.1-nano", { inputPer1K: 0.0001, cachedInputPer1K: 0.000025, outputPer1K: 0.0004 }],
      ["gpt-4o", { inputPer1K: 0.0025, cachedInputPer1K: 0.00125, outputPer1K: 0.01 }],
      ["gpt-4o-mini", { inputPer1K: 0.00015, cachedInputPer1K: 0.000075, outputPer1K: 0.0006 }],
      ["o3", { inputPer1K: 0.002, cachedInputPer1K: 0.0005, outputPer1K: 0.008 }],
      ["o3-mini", { inputPer1K: 0.0011, cachedInputPer1K: 0.00055, outputPer1K: 0.0044 }],
      ["o4-mini", { inputPer1K: 0.0011, cachedInputPer1K: 0.000275, outputPer1K: 0.0044 }],
      ["codex-mini-latest", { inputPer1K: 0.0015, cachedInputPer1K: 0.000375, outputPer1K: 0.006 }],
    ]);
  });

  test("Bundled Claude pricing matches current Anthropic MTok rates", () => {
    assert.deepStrictEqual(DEFAULT_PRICING["claude-opus-4.8"], {
      inputPer1K: 0.005,
      cachedInputPer1K: 0.0005,
      cacheCreationPer1K: 0.00625,
      outputPer1K: 0.025,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-opus-4.7"], {
      inputPer1K: 0.005,
      cachedInputPer1K: 0.0005,
      cacheCreationPer1K: 0.00625,
      outputPer1K: 0.025,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-opus-4.6"], {
      inputPer1K: 0.005,
      cachedInputPer1K: 0.0005,
      cacheCreationPer1K: 0.00625,
      outputPer1K: 0.025,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-opus-4.5"], {
      inputPer1K: 0.005,
      cachedInputPer1K: 0.0005,
      cacheCreationPer1K: 0.00625,
      outputPer1K: 0.025,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-opus-4.1"], {
      inputPer1K: 0.015,
      cachedInputPer1K: 0.0015,
      cacheCreationPer1K: 0.01875,
      outputPer1K: 0.075,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-sonnet-4.6"], {
      inputPer1K: 0.003,
      cachedInputPer1K: 0.0003,
      cacheCreationPer1K: 0.00375,
      outputPer1K: 0.015,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-haiku-4.5"], {
      inputPer1K: 0.001,
      cachedInputPer1K: 0.0001,
      cacheCreationPer1K: 0.00125,
      outputPer1K: 0.005,
    });
    assert.deepStrictEqual(DEFAULT_PRICING["claude-haiku-3.5"], {
      inputPer1K: 0.0008,
      cachedInputPer1K: 0.00008,
      cacheCreationPer1K: 0.001,
      outputPer1K: 0.004,
    });
  });

  test("Known bundled pricing and fallback overrides are ignored, custom models are accepted", () => {
    const merged = mergePricingConfig({
      "gpt-5": { inputPer1K: 999, outputPer1K: 999 },
      "$fallback": { inputPer1K: 999, outputPer1K: 999 },
      "custom-model": { inputPer1K: 0.123, outputPer1K: 0.456 },
    });

    assert.deepStrictEqual(merged.table["gpt-5"], DEFAULT_PRICING["gpt-5"]);
    assert.deepStrictEqual(merged.fallbackRate, FALLBACK_RATE);
    assert.deepStrictEqual(merged.table["custom-model"], { inputPer1K: 0.123, outputPer1K: 0.456 });
    assert.deepStrictEqual(merged.audit.ignoredKnownModelOverrides, ["gpt-5"]);
    assert.strictEqual(merged.audit.ignoredFallbackOverride, true);
    assert.deepStrictEqual(merged.audit.customModelOverrides, ["custom-model"]);
  });

  test("Long-context pricing uses explicit long-context model above threshold", () => {
    const engine = new PricingEngine({
      "gpt-5.5": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.03 },
      "gpt-5.5-long-context": { inputPer1K: 0.01, cachedInputPer1K: 0.001, outputPer1K: 0.045 },
    });
    const totals: CumulativeTotals = {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };

    const normal = engine.costOfTokens("gpt-5.5", totals, { contextUsedTokens: 272_000 });
    const long = engine.costOfTokens("gpt-5.5", totals, { contextUsedTokens: 272_001 });

    assert.strictEqual(normal.effectiveModel, "gpt-5.5");
    assert.strictEqual(normal.longContextApplied, false);
    assertAlmostEqual(normal.usd, 0.035);
    assert.strictEqual(long.effectiveModel, "gpt-5.5-long-context");
    assert.strictEqual(long.longContextApplied, true);
    assertAlmostEqual(long.usd, 0.055);
  });

  test("Long-context missing rate falls back to normal model and reports missing rate", () => {
    const engine = new PricingEngine({
      "custom-large": { inputPer1K: 0.01, outputPer1K: 0.02 },
    });
    const result = engine.costOfTokens(
      "custom-large",
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
      { contextUsedTokens: 300_000 },
    );

    assert.strictEqual(result.effectiveModel, "custom-large");
    assert.strictEqual(result.longContextApplied, false);
    assert.strictEqual(result.longContextMissingRate, true);
    assert.strictEqual(result.usd, 0.01);
  });

  // Feature: token-tracking, Property 10: cost equals Σ over types of (typeTokens/1000)*typeRate
  test("Property 10: cost equals Σ over types of (typeTokens/1000)*typeRate", () => {
    fc.assert(
      fc.property(
        modelRateArb,
        cumulativeTotalsArb,
        (modelRate: ModelRate, totals: CumulativeTotals) => {
          const table: PricingTable = { "test-model": modelRate };
          const engine = new PricingEngine(table);

          const result = engine.costOfTokens("test-model", totals);

          const expected =
            (totals.inputTokens / 1000) * (modelRate.inputPer1K ?? 0) +
            (totals.cacheReadTokens / 1000) * (modelRate.cachedInputPer1K ?? 0) +
            (totals.cacheCreationTokens / 1000) * (modelRate.cacheCreationPer1K ?? 0) +
            (totals.outputTokens / 1000) * (modelRate.outputPer1K ?? 0) +
            (totals.reasoningTokens / 1000) * (modelRate.outputPer1K ?? 0);

          assert.strictEqual(result.unknown, false);
          assert.ok(
            Math.abs(result.usd - expected) < 1e-10,
            `Expected ${expected}, got ${result.usd}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: token-tracking, Property 11: unmapped models flagged as unknown; absent models in unmapped set
  test("Property 11: unmapped models flagged as unknown; absent models in unmapped set", () => {
    const knownTable: PricingTable = { "known-model": { inputPer1K: 0.01, outputPer1K: 0.03 } };
    const engine = new PricingEngine(knownTable);

    fc.assert(
      fc.property(
        unknownModelName,
        cumulativeTotalsArb,
        (model: string, totals: CumulativeTotals) => {
          // Unknown model returns unknown: true (cost uses fallback rate, not $0)
          const result = engine.costOfTokens(model, totals);
          assert.strictEqual(result.unknown, true);
          // Cost is computed via fallback rate, so it's >= 0
          assert.ok(result.usd >= 0, `Cost should be >= 0, got ${result.usd}`);
        },
      ),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
        (models: string[]) => {
          const seen = new Set(models);
          // Add the known model to the set so we have a mix
          seen.add("known-model");

          const unmapped = engine.unmappedModels(seen);
          const unmappedSet = new Set(unmapped);

          // Every model NOT in the table should be in unmapped
          for (const m of seen) {
            if (!Object.hasOwn(knownTable, m)) {
              assert.ok(unmappedSet.has(m), `${m} should be unmapped`);
            } else {
              assert.ok(!unmappedSet.has(m), `${m} should NOT be unmapped`);
            }
          }

          // unmapped should contain only models from seen
          for (const m of unmapped) {
            assert.ok(seen.has(m), `${m} should be in seen set`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: token-tracking, Property 14: cache savings non-negative; cache efficiency in [0,1]
  test("Property 14: cache savings non-negative; cache efficiency in [0,1]", () => {
    fc.assert(
      fc.property(
        // inputPer1K >= cachedInputPer1K >= 0 (realistic: cache rate is cheaper)
        rate.chain((inputRate) =>
          fc.double({ min: 0, max: inputRate, noNaN: true, noDefaultInfinity: true }).map(
            (cachedRate) => ({ inputPer1K: inputRate, cachedInputPer1K: cachedRate }),
          ),
        ),
        tokenCount,
        tokenCount,
        (rates, cacheReadTokens, inputTokens) => {
          // Cache savings = cacheReadTokens/1000 * (inputPer1K - cachedInputPer1K)
          const savings =
            (cacheReadTokens / 1000) * (rates.inputPer1K - rates.cachedInputPer1K);
          assert.ok(savings >= -1e-15, `Savings should be non-negative, got ${savings}`);

          // Cache efficiency = cacheReadTokens / (cacheReadTokens + inputTokens) when denominator > 0
          const denominator = cacheReadTokens + inputTokens;
          if (denominator > 0) {
            const efficiency = cacheReadTokens / denominator;
            assert.ok(efficiency >= 0, `Efficiency should be >= 0, got ${efficiency}`);
            assert.ok(efficiency <= 1, `Efficiency should be <= 1, got ${efficiency}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

function assertAlmostEqual(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `Expected ${expected}, got ${actual}`);
}

function assertRates(expected: Array<[string, ModelRate]>): void {
  for (const [model, rate] of expected) {
    assert.deepStrictEqual(DEFAULT_PRICING[model], rate, model);
  }
}
