import * as assert from "assert";
import fc from "fast-check";
import { writeFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideAction } from "../../worker/ingest.js";
import { computeHeadHash, computeTailAnchorHash } from "../../worker/cursor.js";
import { CodexParser } from "../../worker/parsers/codex.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import type { FileCursor } from "../../shared/storeTypes.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { CumulativeTotals } from "../../shared/types.js";
import type { RawCodexTurn } from "../../shared/types.js";

const MAX_LINE_BYTES = 1_000_000;

/** Build a single valid Codex JSONL turn with cumulative totals. */
function buildCumulativeTurn(
  sessionId: string,
  cumulativeInput: number,
  cumulativeOutput: number,
  cumulativeReasoning: number,
  cumulativeCached: number,
  timestamp: string,
): string[] {
  const turnCtx = JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5-codex", effort: "high" },
  });
  const tokenCount = JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count" },
    timestamp,
    info: {
      total_token_usage: {
        input_tokens: cumulativeInput,
        output_tokens: cumulativeOutput,
        reasoning_output_tokens: cumulativeReasoning,
        cached_input_tokens: cumulativeCached,
        total_tokens: cumulativeInput + cumulativeOutput,
      },
    },
  });
  return [turnCtx, tokenCount];
}

/** Build a full valid Codex session as JSONL lines with per-turn last_token_usage. */
function buildSession(sessionId: string, turns: Array<{ input: number; output: number }>): string[] {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, cwd: "/tmp", cli_version: "1.0.0" },
  }));
  let cumInput = 0;
  let cumOutput = 0;
  for (const t of turns) {
    cumInput += t.input;
    cumOutput += t.output;
    lines.push(JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5-codex", effort: "high" },
    }));
    lines.push(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count" },
      timestamp: "2025-01-01T00:00:00Z",
      info: {
        last_token_usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          total_tokens: t.input + t.output,
        },
        total_token_usage: {
          input_tokens: cumInput,
          output_tokens: cumOutput,
          total_tokens: cumInput + cumOutput,
        },
      },
    }));
  }
  return lines;
}

function tmpFile(prefix: string): string {
  return join(tmpdir(), `pbt-ingest-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

suite("Ingestion property tests", () => {
  // Feature: token-tracking, Property 4: delta differencing — deltas non-negative, sum to final, correct across resume
  test("Property 4: delta differencing of cumulative totals — deltas non-negative, sum to final, correct across resume", async () => {
    const parser = new CodexParser();

    await fc.assert(
      fc.asyncProperty(
        // Generate 2-8 monotonically increasing cumulative totals
        fc.integer({ min: 2, max: 8 }).chain((len) =>
          fc.tuple(
            fc.array(fc.nat({ max: 500 }), { minLength: len, maxLength: len }),
            fc.array(fc.nat({ max: 500 }), { minLength: len, maxLength: len }),
            fc.array(fc.nat({ max: 200 }), { minLength: len, maxLength: len }),
            fc.array(fc.nat({ max: 200 }), { minLength: len, maxLength: len }),
          ),
        ),
        // resumeBoundary: split point for resume (0 = no resume)
        fc.nat({ max: 7 }),
        async ([inputDeltas, outputDeltas, reasoningDeltas, cachedDeltas], resumeBoundary) => {
          const sessionId = "delta-test";
          const numTurns = inputDeltas.length;
          const boundary = Math.min(resumeBoundary, numTurns - 1);

          // Build cumulative totals from deltas
          const cumInput: number[] = [];
          const cumOutput: number[] = [];
          const cumReasoning: number[] = [];
          const cumCached: number[] = [];
          for (let i = 0; i < numTurns; i++) {
            cumInput.push((cumInput[i - 1] ?? 0) + inputDeltas[i]);
            cumOutput.push((cumOutput[i - 1] ?? 0) + outputDeltas[i]);
            cumReasoning.push((cumReasoning[i - 1] ?? 0) + reasoningDeltas[i]);
            cumCached.push((cumCached[i - 1] ?? 0) + cachedDeltas[i]);
          }

          // Build JSONL lines
          const lines: string[] = [
            JSON.stringify({
              type: "session_meta",
              payload: { id: sessionId, cwd: "/tmp", cli_version: "1.0.0" },
            }),
          ];
          for (let i = 0; i < numTurns; i++) {
            lines.push(...buildCumulativeTurn(
              sessionId,
              cumInput[i], cumOutput[i], cumReasoning[i], cumCached[i],
              `2025-01-01T00:0${i}:00Z`,
            ));
          }

          const file = tmpFile("prop4");
          writeFileSync(file, lines.join("\n"), "utf8");

          try {
            let output: ParseOutput | undefined;

            if (boundary > 0) {
              // Parse prefix (first `boundary` turns)
              // Each turn = 2 lines (turn_context + token_count), plus 1 session_meta line
              const prefixLineCount = 1 + boundary * 2;
              const prefixContent = lines.slice(0, prefixLineCount).join("\n");
              const prefixFile = tmpFile("prop4-prefix");
              writeFileSync(prefixFile, prefixContent, "utf8");

              let prefixOutput: ParseOutput | undefined;
              await parser.parse(
                { filePath: prefixFile, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
                (batch) => { prefixOutput = batch; },
              );
              unlinkSync(prefixFile);
              assert.ok(prefixOutput, "Prefix parse should emit output");

              // Resume from prefix endOffset with prefix endState
              const suffixContent = lines.slice(prefixLineCount).join("\n");
              const suffixFile = tmpFile("prop4-suffix");
              // Write full file content for correct offset-based parsing
              writeFileSync(suffixFile, lines.join("\n"), "utf8");

              let suffixOutput: ParseOutput | undefined;
              await parser.parse(
                {
                  filePath: suffixFile,
                  startOffset: prefixOutput.endOffset,
                  maxLineBytes: MAX_LINE_BYTES,
                  resumeState: prefixOutput.endState,
                },
                (batch) => { suffixOutput = batch; },
              );
              unlinkSync(suffixFile);

              // Combine turns
              const allTurns = [
                ...prefixOutput.rawTurns,
                ...(suffixOutput?.rawTurns ?? []),
              ] as RawCodexTurn[];
              output = {
                rawTurns: allTurns,
                toolEvents: [],
                endOffset: suffixOutput?.endOffset ?? prefixOutput.endOffset,
                endState: suffixOutput?.endState ?? prefixOutput.endState,
                malformedCount: 0,
                oversizedCount: 0,
              };
            } else {
              // Full parse, no resume
              await parser.parse(
                { filePath: file, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
                (batch) => { output = batch; },
              );
            }

            assert.ok(output, "Parser should emit output");
            assert.strictEqual(output.rawTurns.length, numTurns, "Should parse all turns");

            // Compute deltas from parsed turns
            const parsedTurns = output.rawTurns as RawCodexTurn[];
            for (let i = 0; i < parsedTurns.length; i++) {
              // All deltas non-negative
              assert.ok(parsedTurns[i].rawInputTokens >= 0,
                `Turn ${i}: inputTokens delta should be non-negative, got ${parsedTurns[i].rawInputTokens}`);
              assert.ok(parsedTurns[i].rawOutputTokens >= 0,
                `Turn ${i}: outputTokens delta should be non-negative, got ${parsedTurns[i].rawOutputTokens}`);
              assert.ok(parsedTurns[i].rawReasoningOutputTokens >= 0,
                `Turn ${i}: reasoningTokens delta should be non-negative, got ${parsedTurns[i].rawReasoningOutputTokens}`);
              assert.ok(parsedTurns[i].rawCachedInputTokens >= 0,
                `Turn ${i}: cachedInputTokens delta should be non-negative, got ${parsedTurns[i].rawCachedInputTokens}`);
            }

            // Sum of deltas equals final cumulative minus initial (0)
            const sumInput = parsedTurns.reduce((s, t) => s + t.rawInputTokens, 0);
            const sumOutput = parsedTurns.reduce((s, t) => s + t.rawOutputTokens, 0);
            const sumReasoning = parsedTurns.reduce((s, t) => s + t.rawReasoningOutputTokens, 0);
            const sumCached = parsedTurns.reduce((s, t) => s + t.rawCachedInputTokens, 0);

            assert.strictEqual(sumInput, cumInput[numTurns - 1],
              `Sum of input deltas (${sumInput}) should equal final cumulative (${cumInput[numTurns - 1]})`);
            assert.strictEqual(sumOutput, cumOutput[numTurns - 1],
              `Sum of output deltas (${sumOutput}) should equal final cumulative (${cumOutput[numTurns - 1]})`);
            assert.strictEqual(sumReasoning, cumReasoning[numTurns - 1],
              `Sum of reasoning deltas (${sumReasoning}) should equal final cumulative (${cumReasoning[numTurns - 1]})`);
            assert.strictEqual(sumCached, cumCached[numTurns - 1],
              `Sum of cached deltas (${sumCached}) should equal final cumulative (${cumCached[numTurns - 1]})`);
          } finally {
            try { unlinkSync(file); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: token-tracking, Property 6: append-parse(prefix)+suffix equals full re-parse(prefix+suffix)
  test("Property 6: append-parse(prefix)+suffix equals full re-parse(prefix+suffix)", async () => {
    const parser = new CodexParser();

    await fc.assert(
      fc.asyncProperty(
        // Generate 3-5 turns with random token values
        fc.integer({ min: 3, max: 5 }).chain((numTurns) =>
          fc.array(
            fc.record({
              input: fc.nat({ max: 2000 }),
              output: fc.nat({ max: 2000 }),
            }),
            { minLength: numTurns, maxLength: numTurns },
          ),
        ),
        // Split point: how many turns in the prefix (at least 1, at most numTurns-1)
        fc.nat({ max: 3 }),
        async (turns, splitOffset) => {
          const sessionId = "append-test";
          const splitAt = Math.max(1, Math.min(splitOffset + 1, turns.length - 1));

          const allLines = buildSession(sessionId, turns);

          // Each turn = 2 lines (turn_context + token_count), plus 1 session_meta
          const prefixLineCount = 1 + splitAt * 2;
          const prefixLines = allLines.slice(0, prefixLineCount);
          const suffixLines = allLines.slice(prefixLineCount);

          const fullFile = tmpFile("prop6-full");
          const prefixFile = tmpFile("prop6-prefix");

          writeFileSync(fullFile, allLines.join("\n"), "utf8");
          writeFileSync(prefixFile, prefixLines.join("\n"), "utf8");

          try {
            // 1. Parse prefix fully
            let prefixOutput: ParseOutput | undefined;
            await parser.parse(
              { filePath: prefixFile, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
              (batch) => { prefixOutput = batch; },
            );
            assert.ok(prefixOutput, "Prefix parse should emit output");

            // 2. Append suffix to prefix file, parse from prefix endOffset with prefix endState
            writeFileSync(fullFile, allLines.join("\n"), "utf8");
            let suffixOutput: ParseOutput | undefined;
            await parser.parse(
              {
                filePath: fullFile,
                startOffset: prefixOutput.endOffset,
                maxLineBytes: MAX_LINE_BYTES,
                resumeState: prefixOutput.endState,
              },
              (batch) => { suffixOutput = batch; },
            );

            // 3. Full re-parse from offset 0
            let fullOutput: ParseOutput | undefined;
            await parser.parse(
              { filePath: fullFile, startOffset: 0, maxLineBytes: MAX_LINE_BYTES },
              (batch) => { fullOutput = batch; },
            );
            assert.ok(fullOutput, "Full parse should emit output");

            // Combine prefix + suffix turns
            const combinedTurns = [
              ...prefixOutput.rawTurns,
              ...(suffixOutput?.rawTurns ?? []),
            ] as RawCodexTurn[];

            const fullTurns = fullOutput.rawTurns as RawCodexTurn[];

            // Assert: same turn count
            assert.strictEqual(combinedTurns.length, fullTurns.length,
              `Combined turn count (${combinedTurns.length}) should equal full parse (${fullTurns.length})`);

            // Assert: same token values per turn
            for (let i = 0; i < fullTurns.length; i++) {
              assert.strictEqual(combinedTurns[i].rawInputTokens, fullTurns[i].rawInputTokens,
                `Turn ${i}: inputTokens mismatch (combined=${combinedTurns[i].rawInputTokens}, full=${fullTurns[i].rawInputTokens})`);
              assert.strictEqual(combinedTurns[i].rawOutputTokens, fullTurns[i].rawOutputTokens,
                `Turn ${i}: outputTokens mismatch`);
              assert.strictEqual(combinedTurns[i].rawTotalTokens, fullTurns[i].rawTotalTokens,
                `Turn ${i}: totalTokens mismatch`);
            }
          } finally {
            try { unlinkSync(fullFile); } catch { /* ignore */ }
            try { unlinkSync(prefixFile); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

suite("Ingestion example tests", () => {
  test("Skip path: decideAction returns 'skip' when cursor matches size+mtime (no fs.open)", () => {
    // Create a temp file to get a real stat
    const file = tmpFile("skip-example");
    writeFileSync(file, "hello world\n", "utf8");

    try {
      const stat = statSync(file);

      const candidate: CandidateFile = {
        filePath: file,
        source: "codex",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileId: "test:1",
      };

      // Build a cursor that matches size+mtime
      const cursor: FileCursor = {
        filePath: file,
        fileId: "test:1",
        source: "codex",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lastByteOffset: stat.size,
        headHash: "irrelevant-because-skip",
        tailAnchorHash: "irrelevant-because-skip",
        runningTotals: {},
        recentRequestIds: [],
        contribution: { daily: [], sessions: [], recordKeys: [], toolEventCount: 0 },
      };

      // decideAction is pure — no I/O. If it returns "skip", no fs.open occurs.
      const decision = decideAction(candidate, cursor);
      assert.strictEqual(decision, "skip");
    } finally {
      unlinkSync(file);
    }
  });

  test("Rewrite detection: keeping first line but changed tail is classified as reingest via hash mismatch", () => {
    const file = tmpFile("rewrite-example");
    const originalContent = "AAAA\nBBBB\n";
    writeFileSync(file, originalContent, "utf8");

    try {
      const stat = statSync(file);

      // Build cursor from original file state
      const headHash = computeHeadHash(file, stat.size);
      const tailAnchorHash = computeTailAnchorHash(file, stat.size);

      const cursor: FileCursor = {
        filePath: file,
        fileId: "test:2",
        source: "codex",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lastByteOffset: stat.size,
        headHash,
        tailAnchorHash,
        runningTotals: {},
        recentRequestIds: [],
        contribution: { daily: [], sessions: [], recordKeys: [], toolEventCount: 0 },
      };

      // Overwrite file keeping first line but changing tail
      const rewrittenContent = "AAAA\nCCCC\n";
      writeFileSync(file, rewrittenContent, "utf8");
      const newStat = statSync(file);

      const candidate: CandidateFile = {
        filePath: file,
        source: "codex",
        size: newStat.size,
        mtimeMs: newStat.mtimeMs,
        fileId: "test:2",
      };

      // decideAction sees size >= lastByteOffset (same size), mtime changed → "append"
      const decision = decideAction(candidate, cursor);
      assert.strictEqual(decision, "append",
        "decideAction should return 'append' when size >= lastByteOffset");

      // But the tail-anchor hash should NOT match (content changed)
      const newTailAnchorHash = computeTailAnchorHash(file, cursor.lastByteOffset);
      assert.notStrictEqual(newTailAnchorHash, cursor.tailAnchorHash,
        "Tail anchor hash should differ after rewrite — ingestFile would promote to reingest");
    } finally {
      unlinkSync(file);
    }
  });
});
