// Feature: token-tracking, Property 17: a unique sentinel embedded in
// prompt/text/content/reasoning never appears in any UsageRecord, store row,
// or emitted WebView message.

import * as assert from "assert";
import fc from "fast-check";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodexParser } from "../../worker/parsers/codex.js";
import { normalize } from "../../worker/normalizer.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import type { UsageRecord } from "../../shared/types.js";

suite("Privacy sentinel property test", () => {
  test("Property 17: sentinel in content never leaks into UsageRecord or ParseOutput fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 64 }).filter((s) => !s.includes('"') && !s.includes("\\")),
        async (sentinel) => {
          // Create a Codex JSONL file with the sentinel embedded in a
          // response_item content field (which parsers should ignore for token data)
          const tmpDir = mkdtempSync(join(tmpdir(), "privacy-"));
          const filePath = join(tmpDir, "rollout-test.jsonl");

          const lines = [
            JSON.stringify({
              type: "session_meta",
              payload: { id: "sess-priv", cwd: "/tmp", cli_version: "1.0" },
            }),
            JSON.stringify({
              type: "turn_context",
              payload: { model: "gpt-5-codex", effort: "high" },
            }),
            // This is the content line with the sentinel — parsers should NOT extract text content
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                content: [{ type: "output_text", text: `Secret: ${sentinel}` }],
                reasoning: `Thinking about ${sentinel}`,
              },
            }),
            // A function_call with sentinel in arguments
            JSON.stringify({
              type: "response_item",
              payload: { type: "function_call", name: "shell", arguments: sentinel },
            }),
            // The token_count line (no sentinel in token data)
            JSON.stringify({
              type: "event_msg",
              payload: { type: "token_count" },
              timestamp: "2025-01-15T10:00:00Z",
              info: {
                last_token_usage: {
                  input_tokens: 100,
                  cached_input_tokens: 20,
                  output_tokens: 50,
                  reasoning_output_tokens: 10,
                  total_tokens: 150,
                },
                model_context_window: 128000,
              },
            }),
          ];

          writeFileSync(filePath, lines.join("\n") + "\n");

          try {
            // Parse
            const parser = new CodexParser();
            let output: ParseOutput | undefined;
            await parser.parse(
              { filePath, startOffset: 0, maxLineBytes: 1_048_576 },
              (batch) => { output = batch; },
            );

            assert.ok(output, "Parser should produce output");

            // Check ParseOutput fields don't contain sentinel
            const parseStr = JSON.stringify(output);
            assert.ok(
              !parseStr.includes(sentinel),
              `Sentinel "${sentinel}" found in ParseOutput`,
            );

            // Normalize raw turns → UsageRecords
            const records: UsageRecord[] = output!.rawTurns.map((raw) => normalize(raw));

            // Check UsageRecords don't contain sentinel
            for (const rec of records) {
              const recStr = JSON.stringify(rec);
              assert.ok(
                !recStr.includes(sentinel),
                `Sentinel "${sentinel}" found in UsageRecord`,
              );
            }
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
