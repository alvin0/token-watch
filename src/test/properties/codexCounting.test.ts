import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexParser } from "../../worker/parsers/codex.js";
import { normalizeCodexTurn } from "../../worker/normalizer.js";
import type { RawCodexTurn } from "../../shared/types.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import {
  CODEX_PARSE_REVISION,
  LEGACY_V6_PARSE_REVISION,
  parseRevisionForSource,
} from "../../worker/parsers/revision.js";

/**
 * Codex reports a cumulative total per rollout file, and every one of these
 * tests exists because a real set of logs disagreed with what the parser made
 * of it. The measurements quoted are from that comparison.
 */
suite("Codex cumulative counting", () => {
  let dir: string;

  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-codex-count-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  function meta(sessionId: string): string {
    return JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, cwd: "/repo", cli_version: "1.0.0" },
    });
  }

  function context(): string {
    return JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } });
  }

  /** One token_count line reporting a cumulative reading. */
  function reading(
    input: number,
    output: number,
    extra: { cached?: number; reasoning?: number; second?: number } = {},
  ): string {
    return JSON.stringify({
      type: "event_msg",
      timestamp: `2026-06-03T10:00:${String(extra.second ?? 0).padStart(2, "0")}.000Z`,
      payload: {
        type: "token_count",
        info: {
          model_context_window: 272000,
          last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: extra.cached ?? 0,
            output_tokens: output,
            reasoning_output_tokens: extra.reasoning ?? 0,
            total_tokens: input + output,
          },
        },
      },
    });
  }

  async function parse(lines: string[]): Promise<RawCodexTurn[]> {
    const file = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const turns: RawCodexTurn[] = [];
    await new CodexParser().parse(
      { filePath: file, fileId: "f:1", startOffset: 0, endOffset: statSync(file).size, maxLineBytes: 1_048_576 },
      (batch) => { turns.push(...(batch.rawTurns as RawCodexTurn[])); },
    );
    return turns;
  }

  const consumed = (turns: RawCodexTurn[]): number =>
    turns.reduce((sum, t) => sum + t.rawInputTokens + t.rawOutputTokens, 0);

  test("a resumed session does not re-count the history it replays", async () => {
    // Resuming writes the earlier turns again under the old session id, then
    // continues under a new one FROM THE SAME cumulative number. Keying the
    // baseline by session id made that first line after the switch look like a
    // turn that had consumed the entire history: 10.3 billion tokens too many,
    // 39% over, across one real set of logs.
    const turns = await parse([
      meta("session-old"),
      context(),
      reading(1_000, 100, { second: 1 }),
      reading(5_000, 500, { second: 2 }),
      reading(9_000, 900, { second: 3 }),
      meta("session-new"),
      context(),
      reading(9_100, 950, { second: 4 }),
      reading(9_300, 1_000, { second: 5 }),
    ]);

    assert.strictEqual(
      consumed(turns),
      10_300,
      "the file's final cumulative reading is the whole of what it consumed",
    );
  });

  test("the counter restarting is a new epoch, not a turn to discard", async () => {
    // A new conversation in the same file restarts the counter. Those earlier
    // tokens were still consumed; dropping the line, as this used to, threw
    // them away.
    const turns = await parse([
      meta("s1"),
      context(),
      reading(1_000, 100, { second: 1 }),
      reading(4_000, 400, { second: 2 }),
      // Restart.
      reading(50, 5, { second: 3 }),
      reading(700, 70, { second: 4 }),
    ]);

    assert.strictEqual(consumed(turns), 4_400 + 770, "both epochs count in full");
  });

  test("a reading that consumed nothing is not a turn", async () => {
    const turns = await parse([
      meta("s1"),
      context(),
      reading(1_000, 100, { second: 1 }),
      reading(1_000, 100, { second: 2 }),
      reading(1_000, 100, { second: 3 }),
    ]);
    assert.strictEqual(turns.length, 1, "the repeats added nothing and are not turns");
    assert.strictEqual(consumed(turns), 1_100);
  });

  test("a component going backwards cannot inflate the total", async () => {
    // Cumulative input dips while output rises. Clamping each component on its
    // own reported more tokens than the turn used; the total Codex reports is
    // the number to hold on to.
    const turns = await parse([
      meta("s1"),
      context(),
      reading(1_000, 100, { second: 1 }),
      reading(900, 400, { second: 2 }),
    ]);

    assert.strictEqual(
      consumed(turns),
      1_300,
      "1,100 then 1,300 cumulative means 1,300 consumed, not more",
    );
    for (const turn of turns) {
      assert.ok(turn.rawInputTokens >= 0, `input must not go negative: ${turn.rawInputTokens}`);
      assert.ok(turn.rawOutputTokens >= 0, `output must not go negative: ${turn.rawOutputTokens}`);
    }
  });

  test("cached and reasoning stay inside the buckets that contain them", async () => {
    // The logs occasionally report more cached than input for a delta. Keeping
    // the whole cached figure while clamping the subtraction made the five
    // buckets add up to more than the turn used — 1,082,736 tokens too many
    // across 45 turns in one real set of logs.
    const turns = await parse([
      meta("s1"),
      context(),
      reading(1_000, 500, { cached: 0, reasoning: 0, second: 1 }),
      reading(1_100, 900, { cached: 900, reasoning: 800, second: 2 }),
    ]);

    for (const turn of turns) {
      const record = normalizeCodexTurn(turn);
      const buckets = record.inputTokens + record.outputTokens + record.cacheReadTokens
        + record.cacheCreationTokens + record.reasoningTokens;
      assert.strictEqual(
        buckets,
        turn.rawInputTokens + turn.rawOutputTokens,
        "the five disjoint buckets must sum to exactly what the turn used",
      );
      assert.ok(record.cacheReadTokens <= turn.rawInputTokens, "cached sits inside input");
      assert.ok(record.reasoningTokens <= turn.rawOutputTokens, "reasoning sits inside output");
    }
  });

  test("a database counted by the old parser is re-read, not left wrong", async () => {
    // The logs do not change when a parser is corrected, so nothing would prompt
    // a re-read on its own. The cursor records which revision produced it, and a
    // cursor from an older one is read again from the start — that is the only
    // route a correction has to numbers already stored.
    assert.ok(
      CODEX_PARSE_REVISION > 1,
      "correcting how Codex is counted has to move the revision",
    );
    assert.strictEqual(
      parseRevisionForSource("codex"),
      CODEX_PARSE_REVISION,
      "and cursors have to be stamped with it",
    );
    assert.ok(
      LEGACY_V6_PARSE_REVISION < CODEX_PARSE_REVISION,
      "a schema 6 database was counted by the old parser, so it must be re-read too",
    );
  });

  test("resuming a parse mid-file picks up where the counter was", async () => {
    // The cursor carries the running total per session id. After a resume the
    // baseline has to be where the file had got to, not zero, or the next turn
    // is charged for everything before it.
    const lines = [
      meta("s1"),
      context(),
      reading(1_000, 100, { second: 1 }),
      reading(5_000, 500, { second: 2 }),
      reading(9_000, 900, { second: 3 }),
    ];
    const file = join(dir, "resume.jsonl");

    writeFileSync(file, `${lines.slice(0, 4).join("\n")}\n`, "utf8");
    const parser = new CodexParser();
    let prefix: ParseOutput | undefined;
    await parser.parse(
      { filePath: file, fileId: "f:1", startOffset: 0, endOffset: statSync(file).size, maxLineBytes: 1_048_576 },
      (batch) => { prefix = batch; },
    );
    assert.ok(prefix);

    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    const rest: RawCodexTurn[] = [];
    await parser.parse(
      {
        filePath: file,
        fileId: "f:1",
        startOffset: prefix.endOffset,
        endOffset: statSync(file).size,
        maxLineBytes: 1_048_576,
        resumeState: prefix.endState,
      },
      (batch) => { rest.push(...(batch.rawTurns as RawCodexTurn[])); },
    );

    const all = [...(prefix.rawTurns as RawCodexTurn[]), ...rest];
    assert.strictEqual(consumed(all), 9_900, "the two halves must add up to the final reading");
  });
});
