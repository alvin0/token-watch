import * as assert from "assert";
import fc from "fast-check";

import { Effort, UsageRecord, totalTokens } from "../../shared/types";
import { baseModelOf, makeVariantId } from "../../shared/variant";

/**
 * Property tests for the documented token total (Property 3) and the variant
 * id round-trip (Property 2). These exercise pure logic in `src/shared/*` and
 * must NOT import `vscode`.
 */

/** Real reasoning-effort levels (excludes the no-effort sentinel "n/a"). */
const REAL_EFFORTS: Effort[] = ["minimal", "low", "medium", "high", "xhigh"];

/** Non-negative token-bucket counts. Capped so five of them can't overflow. */
const tokenCount = fc.nat({ max: 1_000_000_000 });

/**
 * Model ids drawn from a parenthesis-free alphabet so a generated model can
 * never accidentally look like an effort-suffixed variant id (e.g. avoid
 * producing a model literally named "foo (high)"). This keeps Property 2's
 * "suffix present iff effort" assertion meaningful.
 */
const modelString = fc.string({
  minLength: 1,
  maxLength: 24,
  unit: fc.constantFrom(
    "a", "b", "c", "g", "p", "t", "o", "n", "m", "x", "5", "4", "7",
    "-", ".", " ",
  ),
});

suite("Token Watch shared logic properties", () => {
  // Feature: token-tracking, Property 3: totalTokens equals the sum of the five disjoint buckets
  test("Property 3: totalTokens equals the sum of the five disjoint buckets", () => {
    fc.assert(
      fc.property(
        fc.record({
          source: fc.constantFrom("codex" as const, "claude" as const),
          sessionId: fc.string(),
          dedupKey: fc.string(),
          timestamp: fc.nat(),
          model: modelString,
          variantId: fc.string(),
          inputTokens: tokenCount,
          outputTokens: tokenCount,
          cacheReadTokens: tokenCount,
          cacheCreationTokens: tokenCount,
          reasoningTokens: tokenCount,
        }),
        (r: UsageRecord) => {
          const expected =
            r.inputTokens +
            r.outputTokens +
            r.cacheReadTokens +
            r.cacheCreationTokens +
            r.reasoningTokens;
          assert.strictEqual(totalTokens(r), expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: token-tracking, Property 2: baseModelOf(makeVariantId(m,e)) === m; suffix present iff effort
  test("Property 2: variant id round-trips and suffix is present iff a real effort", () => {
    fc.assert(
      fc.property(
        modelString,
        fc.option(fc.constantFrom<Effort>(...REAL_EFFORTS, "n/a"), {
          nil: undefined,
        }),
        (model: string, effort: Effort | undefined) => {
          const variantId = makeVariantId(model, effort);

          // Round-trip: the base model is always recoverable.
          assert.strictEqual(baseModelOf(variantId), model);

          // Suffix is present iff a real effort was supplied (not undefined, not "n/a").
          const hasRealEffort = effort !== undefined && effort !== "n/a";
          if (hasRealEffort) {
            assert.strictEqual(variantId, `${model} (${effort})`);
          } else {
            assert.strictEqual(variantId, model);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
