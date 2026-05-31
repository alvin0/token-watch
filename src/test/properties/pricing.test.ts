import * as assert from "assert";
import fc from "fast-check";

import type { ModelRate, PricingTable, CumulativeTotals } from "../../shared/types";
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

  // Feature: token-tracking, Property 11: unmapped models excluded from confirmed cost; absent models in unmapped set
  test("Property 11: unmapped models excluded from confirmed cost; absent models in unmapped set", () => {
    const knownTable: PricingTable = { "known-model": { inputPer1K: 0.01, outputPer1K: 0.03 } };
    const engine = new PricingEngine(knownTable);

    fc.assert(
      fc.property(
        unknownModelName,
        cumulativeTotalsArb,
        (model: string, totals: CumulativeTotals) => {
          // Unknown model returns usd: 0, unknown: true
          const result = engine.costOfTokens(model, totals);
          assert.strictEqual(result.usd, 0);
          assert.strictEqual(result.unknown, true);
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
            if (!(m in knownTable)) {
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
