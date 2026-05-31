import * as assert from "assert";
import fc from "fast-check";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexParser } from "../../worker/parsers/codex.js";
import { ClaudeParser } from "../../worker/parsers/claude.js";
import { normalizeCodexTurn, normalizeClaudeTurn } from "../../worker/normalizer.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import type { RawCodexTurn, RawClaudeTurn } from "../../shared/types.js";

// Feature: token-tracking, Property 1: parse→normalize round-trip reproduces UsageRecords

suite("Parse + normalize round-trip property tests", () => {
  test("Property 1: Codex parse→normalize reproduces expected UsageRecords", async () => {
    const parser = new CodexParser();

    const turnArb = fc.record({
      input: fc.nat({ max: 100_000 }),
      cached: fc.nat({ max: 100_000 }),
      output: fc.nat({ max: 100_000 }),
      reasoning: fc.nat({ max: 100_000 }),
    }).map((t) => ({
      // Enforce constraints: cached <= input, reasoning <= output
      input: t.input + t.cached, // total input includes cached
      cached: t.cached,
      output: t.output + t.reasoning, // total output includes reasoning
      reasoning: t.reasoning,
      total: t.input + t.cached + t.output + t.reasoning,
    }));

    await fc.assert(
      fc.asyncProperty(
        fc.array(turnArb, { minLength: 1, maxLength: 10 }),
        async (turns) => {
          const sessionId = "roundtrip-codex-session";
          const model = "gpt-5-codex";
          const effort = "high";

          // Build JSONL lines
          const lines: string[] = [];
          lines.push(JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId, cwd: "/tmp", cli_version: "1.0.0" },
          }));
          lines.push(JSON.stringify({
            type: "turn_context",
            payload: { model, effort },
          }));

          for (const turn of turns) {
            lines.push(JSON.stringify({
              type: "event_msg",
              payload: { type: "token_count" },
              timestamp: "2025-01-01T00:00:00Z",
              info: {
                last_token_usage: {
                  input_tokens: turn.input,
                  cached_input_tokens: turn.cached,
                  output_tokens: turn.output,
                  reasoning_output_tokens: turn.reasoning,
                  total_tokens: turn.total,
                },
                total_token_usage: {
                  input_tokens: turn.input,
                  cached_input_tokens: turn.cached,
                  output_tokens: turn.output,
                  reasoning_output_tokens: turn.reasoning,
                  total_tokens: turn.total,
                },
              },
            }));
          }

          // Write temp file
          const tmpFile = join(tmpdir(), `pbt-rt-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
          writeFileSync(tmpFile, lines.join("\n"), "utf8");

          try {
            let output: ParseOutput | undefined;
            await parser.parse(
              { filePath: tmpFile, startOffset: 0, maxLineBytes: 1_000_000 },
              (batch) => { output = batch; },
            );
            assert.ok(output, "Parser should emit output");
            assert.strictEqual(output.rawTurns.length, turns.length, "Turn count mismatch");

            for (let i = 0; i < turns.length; i++) {
              const raw = output.rawTurns[i] as RawCodexTurn;
              const record = normalizeCodexTurn(raw);
              const expected = turns[i];

              assert.strictEqual(record.inputTokens, expected.input - expected.cached,
                `Turn ${i}: inputTokens expected ${expected.input - expected.cached}, got ${record.inputTokens}`);
              assert.strictEqual(record.outputTokens, expected.output - expected.reasoning,
                `Turn ${i}: outputTokens expected ${expected.output - expected.reasoning}, got ${record.outputTokens}`);
              assert.strictEqual(record.cacheReadTokens, expected.cached,
                `Turn ${i}: cacheReadTokens expected ${expected.cached}, got ${record.cacheReadTokens}`);
              assert.strictEqual(record.reasoningTokens, expected.reasoning,
                `Turn ${i}: reasoningTokens expected ${expected.reasoning}, got ${record.reasoningTokens}`);
              assert.strictEqual(record.cacheCreationTokens, 0,
                `Turn ${i}: cacheCreationTokens expected 0, got ${record.cacheCreationTokens}`);
            }
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Property 1: Claude parse→normalize reproduces expected UsageRecords", async () => {
    const parser = new ClaudeParser();

    const turnArb = fc.record({
      input: fc.nat({ max: 100_000 }),
      output: fc.nat({ max: 100_000 }),
      cacheRead: fc.nat({ max: 100_000 }),
      cacheCreation: fc.nat({ max: 100_000 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(turnArb, { minLength: 1, maxLength: 10 }),
        async (turns) => {
          const sessionId = "roundtrip-claude-session";
          const model = "claude-opus-4.7";

          // Build JSONL lines — each turn is a distinct assistant line with unique requestId
          const lines: string[] = [];
          for (let i = 0; i < turns.length; i++) {
            const turn = turns[i];
            lines.push(JSON.stringify({
              type: "assistant",
              sessionId,
              requestId: `req-${i}`,
              timestamp: "2025-01-01T00:00:00Z",
              message: {
                model,
                usage: {
                  input_tokens: turn.input,
                  output_tokens: turn.output,
                  cache_read_input_tokens: turn.cacheRead,
                  cache_creation_input_tokens: turn.cacheCreation,
                },
                content: [],
              },
            }));
          }

          // Write temp file
          const tmpFile = join(tmpdir(), `pbt-rt-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
          writeFileSync(tmpFile, lines.join("\n"), "utf8");

          try {
            let output: ParseOutput | undefined;
            await parser.parse(
              { filePath: tmpFile, startOffset: 0, maxLineBytes: 1_000_000 },
              (batch) => { output = batch; },
            );
            assert.ok(output, "Parser should emit output");
            assert.strictEqual(output.rawTurns.length, turns.length, "Turn count mismatch");

            for (let i = 0; i < turns.length; i++) {
              const raw = output.rawTurns[i] as RawClaudeTurn;
              const record = normalizeClaudeTurn(raw);
              const expected = turns[i];

              assert.strictEqual(record.inputTokens, expected.input,
                `Turn ${i}: inputTokens expected ${expected.input}, got ${record.inputTokens}`);
              assert.strictEqual(record.outputTokens, expected.output,
                `Turn ${i}: outputTokens expected ${expected.output}, got ${record.outputTokens}`);
              assert.strictEqual(record.cacheReadTokens, expected.cacheRead,
                `Turn ${i}: cacheReadTokens expected ${expected.cacheRead}, got ${record.cacheReadTokens}`);
              assert.strictEqual(record.cacheCreationTokens, expected.cacheCreation,
                `Turn ${i}: cacheCreationTokens expected ${expected.cacheCreation}, got ${record.cacheCreationTokens}`);
              assert.strictEqual(record.reasoningTokens, 0,
                `Turn ${i}: reasoningTokens expected 0, got ${record.reasoningTokens}`);
            }
          } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
