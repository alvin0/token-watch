import * as assert from "assert";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeCodexTurn, normalizeClaudeTurn } from "../../worker/normalizer.js";
import { totalTokens } from "../../shared/types.js";
import type { RawCodexTurn, RawClaudeTurn } from "../../shared/types.js";

// Feature: token-tracking, Property 18: Codex buckets are disjoint, non-negative,
// and their sum equals raw total_tokens; Claude direct-mapped buckets are non-negative
// and don't double count.

suite("Normalizer decomposition property tests", () => {
  test("Property 18 (Codex): buckets are disjoint, non-negative, sum equals rawTotalTokens", () => {
    fc.assert(
      fc.property(
        fc.record({
          rawInputTokens: fc.nat({ max: 100_000 }),
          rawCachedInputTokens: fc.nat({ max: 100_000 }),
          rawOutputTokens: fc.nat({ max: 100_000 }),
          rawReasoningOutputTokens: fc.nat({ max: 100_000 }),
        }).map(({ rawInputTokens, rawCachedInputTokens, rawOutputTokens, rawReasoningOutputTokens }) => {
          // Enforce constraints: cached <= input, reasoning <= output
          const cachedInput = Math.min(rawCachedInputTokens, rawInputTokens);
          const reasoningOutput = Math.min(rawReasoningOutputTokens, rawOutputTokens);
          const raw: RawCodexTurn = {
            source: "codex",
            sessionId: "sess-1",
            dedupKey: "codex:sess-1:0",
            timestamp: Date.now(),
            model: "gpt-5-codex",
            effort: "high",
            rawInputTokens,
            rawCachedInputTokens: cachedInput,
            rawOutputTokens,
            rawReasoningOutputTokens: reasoningOutput,
            rawTotalTokens: rawInputTokens + rawOutputTokens,
          };
          return raw;
        }),
        (raw) => {
          const record = normalizeCodexTurn(raw);

          // All five buckets non-negative
          assert.ok(record.inputTokens >= 0, `inputTokens negative: ${record.inputTokens}`);
          assert.ok(record.outputTokens >= 0, `outputTokens negative: ${record.outputTokens}`);
          assert.ok(record.cacheReadTokens >= 0, `cacheReadTokens negative: ${record.cacheReadTokens}`);
          assert.ok(record.cacheCreationTokens >= 0, `cacheCreationTokens negative: ${record.cacheCreationTokens}`);
          assert.ok(record.reasoningTokens >= 0, `reasoningTokens negative: ${record.reasoningTokens}`);

          // Sum equals raw total
          assert.strictEqual(
            totalTokens(record),
            raw.rawTotalTokens,
            `Sum ${totalTokens(record)} !== rawTotalTokens ${raw.rawTotalTokens}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Property 18 (Claude): buckets are non-negative, no double counting", () => {
    fc.assert(
      fc.property(
        fc.record({
          rawInputTokens: fc.nat({ max: 100_000 }),
          rawOutputTokens: fc.nat({ max: 100_000 }),
          rawCacheReadTokens: fc.nat({ max: 100_000 }),
          rawCacheCreationTokens: fc.nat({ max: 100_000 }),
        }).map(({ rawInputTokens, rawOutputTokens, rawCacheReadTokens, rawCacheCreationTokens }) => {
          const raw: RawClaudeTurn = {
            source: "claude",
            sessionId: "sess-2",
            dedupKey: "claude:sess-2:req-1",
            timestamp: Date.now(),
            model: "claude-opus-4.7",
            rawInputTokens,
            rawOutputTokens,
            rawCacheReadTokens,
            rawCacheCreationTokens,
          };
          return raw;
        }),
        (raw) => {
          const record = normalizeClaudeTurn(raw);

          // All five buckets non-negative
          assert.ok(record.inputTokens >= 0, `inputTokens negative: ${record.inputTokens}`);
          assert.ok(record.outputTokens >= 0, `outputTokens negative: ${record.outputTokens}`);
          assert.ok(record.cacheReadTokens >= 0, `cacheReadTokens negative: ${record.cacheReadTokens}`);
          assert.ok(record.cacheCreationTokens >= 0, `cacheCreationTokens negative: ${record.cacheCreationTokens}`);
          assert.ok(record.reasoningTokens >= 0, `reasoningTokens negative: ${record.reasoningTokens}`);

          // No double counting: each bucket maps directly from a distinct raw field
          assert.strictEqual(record.inputTokens, raw.rawInputTokens);
          assert.strictEqual(record.outputTokens, raw.rawOutputTokens);
          assert.strictEqual(record.cacheReadTokens, raw.rawCacheReadTokens);
          assert.strictEqual(record.cacheCreationTokens, raw.rawCacheCreationTokens);
          assert.strictEqual(record.reasoningTokens, 0);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Example: real Codex fixture token_count line normalizes correctly", () => {
    const fixturePath = join(__dirname, "../../../src/test/fixtures/codex-session.jsonl");
    const content = readFileSync(fixturePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    // Find the first token_count line
    const tokenCountLine = lines.find((l) => {
      const parsed = JSON.parse(l);
      return parsed.type === "event_msg" && parsed.payload?.type === "token_count";
    });
    assert.ok(tokenCountLine, "Fixture must contain a token_count line");

    const parsed = JSON.parse(tokenCountLine);
    const usage = parsed.info.last_token_usage;

    // Build RawCodexTurn from the fixture data
    const raw: RawCodexTurn = {
      source: "codex",
      sessionId: "codex-sess-abc123",
      dedupKey: "codex:codex-sess-abc123:0",
      timestamp: new Date(parsed.timestamp ?? "2025-01-15T10:00:15.000Z").getTime(),
      model: "gpt-5-codex",
      effort: "high",
      rawInputTokens: usage.input_tokens,           // 5000
      rawCachedInputTokens: usage.cached_input_tokens, // 2000
      rawOutputTokens: usage.output_tokens,          // 3000
      rawReasoningOutputTokens: usage.reasoning_output_tokens, // 1000
      rawTotalTokens: usage.total_tokens,            // 8000
    };

    const record = normalizeCodexTurn(raw);

    assert.strictEqual(record.cacheReadTokens, 2000);
    assert.strictEqual(record.inputTokens, 3000);       // 5000 - 2000
    assert.strictEqual(record.reasoningTokens, 1000);
    assert.strictEqual(record.outputTokens, 2000);      // 3000 - 1000
    assert.strictEqual(record.cacheCreationTokens, 0);
    assert.strictEqual(totalTokens(record), 8000);
  });
});
