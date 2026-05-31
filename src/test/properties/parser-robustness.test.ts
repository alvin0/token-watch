import * as assert from "assert";
import fc from "fast-check";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexParser } from "../../worker/parsers/codex.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import type { RawCodexTurn } from "../../shared/types.js";

/**
 * Property tests for parser robustness against malformed, oversized, and
 * irrelevant lines. Must NOT import `vscode`.
 */

/** Small maxLineBytes so we can easily craft "oversized" lines. */
const MAX_LINE_BYTES = 500;

/** Build a minimal valid Codex session as JSONL lines. */
function buildValidSession(sessionId: string, inputTokens: number, outputTokens: number): string[] {
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, cwd: "/tmp", cli_version: "1.0.0" },
  });
  const turnCtx = JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5-codex", effort: "high" },
  });
  const tokenCount = JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count" },
    timestamp: "2025-01-01T00:00:00Z",
    info: {
      last_token_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      total_token_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  });
  return [meta, turnCtx, tokenCount];
}

/** Interleave noise lines at random positions among valid lines. */
function interleave(validLines: string[], noiseLines: string[], positions: number[]): string[] {
  const result = [...validLines];
  for (let i = 0; i < noiseLines.length; i++) {
    // Insert at a position within [0, result.length]
    const pos = positions[i] % (result.length + 1);
    result.splice(pos, 0, noiseLines[i]);
  }
  return result;
}

suite("Parser robustness property tests", () => {
  // Feature: token-tracking, Property 5: malformed/oversized/irrelevant lines don't change emitted raw turns
  test("Property 5: malformed/oversized/irrelevant lines don't change emitted raw turns; counters accurate", async () => {
    const parser = new CodexParser();

    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 5 }),  // numMalformed
        fc.nat({ max: 5 }),  // numOversized
        fc.nat({ max: 5 }),  // numIrrelevant
        fc.nat({ max: 5000 }),  // inputTokens
        fc.nat({ max: 5000 }),  // outputTokens
        fc.array(fc.nat({ max: 100 }), { minLength: 15, maxLength: 15 }), // positions
        async (numMalformed, numOversized, numIrrelevant, inputTokens, outputTokens, positions) => {
          const sessionId = "test-session";
          const validLines = buildValidSession(sessionId, inputTokens, outputTokens);

          // Generate noise lines deterministically from counts
          const malformedLines: string[] = [];
          for (let i = 0; i < numMalformed; i++) {
            // Must contain a keyword to pass the fast-path filter and reach JSON.parse
            malformedLines.push(`{broken "token_count" line_${i}`);
          }

          const oversizedLines: string[] = [];
          for (let i = 0; i < numOversized; i++) {
            const padding = "x".repeat(MAX_LINE_BYTES + 100);
            oversizedLines.push(JSON.stringify({ type: "session_meta", payload: { id: `os-${i}`, data: padding } }));
          }

          const irrelevantLines: string[] = [];
          for (let i = 0; i < numIrrelevant; i++) {
            irrelevantLines.push(JSON.stringify({ type: "unknown_event", data: { seq: i } }));
          }

          const allNoise = [...malformedLines, ...oversizedLines, ...irrelevantLines];
          const combined = interleave(validLines, allNoise, positions);

          // Write to temp file
          const tmpFile = join(tmpdir(), `pbt-robustness-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
          writeFileSync(tmpFile, combined.join("\n"), "utf8");

          try {
            // Parse with noise
            let noisyOutput: ParseOutput | undefined;
            await parser.parse(
              { filePath: tmpFile, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
              (batch) => { noisyOutput = batch; },
            );
            assert.ok(noisyOutput, "Parser should emit output");

            // Parse without noise (baseline)
            const cleanFile = join(tmpdir(), `pbt-robustness-clean-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
            writeFileSync(cleanFile, validLines.join("\n"), "utf8");

            let cleanOutput: ParseOutput | undefined;
            await parser.parse(
              { filePath: cleanFile, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
              (batch) => { cleanOutput = batch; },
            );
            assert.ok(cleanOutput, "Clean parse should emit output");
            unlinkSync(cleanFile);

            // Assert: same number of raw turns
            assert.strictEqual(
              noisyOutput.rawTurns.length,
              cleanOutput.rawTurns.length,
              `Turn count mismatch: noisy=${noisyOutput.rawTurns.length}, clean=${cleanOutput.rawTurns.length}`,
            );

            // Assert: same token values per turn
            for (let i = 0; i < cleanOutput.rawTurns.length; i++) {
              const clean = cleanOutput.rawTurns[i] as RawCodexTurn;
              const noisy = noisyOutput.rawTurns[i] as RawCodexTurn;
              assert.strictEqual(noisy.rawInputTokens, clean.rawInputTokens, `Turn ${i} inputTokens mismatch`);
              assert.strictEqual(noisy.rawOutputTokens, clean.rawOutputTokens, `Turn ${i} outputTokens mismatch`);
              assert.strictEqual(noisy.rawTotalTokens, clean.rawTotalTokens, `Turn ${i} totalTokens mismatch`);
            }

            // Assert: malformedCount equals number of malformed lines injected
            assert.strictEqual(
              noisyOutput.malformedCount,
              numMalformed,
              `malformedCount: expected ${numMalformed}, got ${noisyOutput.malformedCount}`,
            );

            // Assert: oversizedCount equals number of oversized lines injected
            assert.strictEqual(
              noisyOutput.oversizedCount,
              numOversized,
              `oversizedCount: expected ${numOversized}, got ${noisyOutput.oversizedCount}`,
            );

            // Assert: irrelevant lines increment neither counter
            // (total noise = malformed + oversized + irrelevant, but only malformed + oversized counted)
            assert.strictEqual(
              noisyOutput.malformedCount + noisyOutput.oversizedCount,
              numMalformed + numOversized,
              "Irrelevant lines should not increment either counter",
            );
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
