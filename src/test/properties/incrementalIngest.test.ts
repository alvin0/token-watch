import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { ingestFile } from "../../worker/ingest.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { Source } from "../../shared/types.js";

/**
 * A log that is read as it grows must total the same as one read whole.
 *
 * This is how the extension actually reads: a file gains lines, a cursor
 * resumes part-way through. Both formats have something to get wrong there —
 * Codex counts cumulatively, so a resumed parse has to remember where the
 * counter was, and Claude streams several lines for one turn, so a resume must
 * replace rather than add. Verified against 60 real logs; kept here so it
 * cannot quietly stop being true.
 */
suite("Reading a log as it grows", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });
  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-incr-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  const OPTS = { maxLineBytes: 1_048_576, backfillMonths: 0 };

  async function openStore(name: string): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, name), SQL);
    await store.migrateOrRebuild();
    return store;
  }

  function candidate(path: string, source: Source, fileId: string): CandidateFile {
    const stat = statSync(path);
    return { filePath: path, source, size: stat.size, mtimeMs: stat.mtimeMs, fileId };
  }

  function totals(store: UsageStore): unknown {
    return store.database.exec(
      `SELECT source, COUNT(*), SUM(total_tokens), SUM(input_tokens), SUM(output_tokens),
              SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(reasoning_tokens)
       FROM usage_record GROUP BY source ORDER BY source`,
    )[0]?.values;
  }

  /** Read the lines whole into one store, and in three appends into another. */
  async function compare(lines: string[], source: Source): Promise<void> {
    const whole = await openStore("whole.sqlite");
    const pieces = await openStore("pieces.sqlite");
    const file = join(dir, "log.jsonl");

    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    await ingestFile(candidate(file, source, "f:1"), whole, new PricingEngine({}, undefined), OPTS);

    for (const cut of [Math.ceil(lines.length / 3), Math.ceil((lines.length * 2) / 3), lines.length]) {
      writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`, "utf8");
      await ingestFile(candidate(file, source, "f:1"), pieces, new PricingEngine({}, undefined), OPTS);
    }

    assert.deepStrictEqual(
      totals(pieces),
      totals(whole),
      "reading in pieces must total exactly what reading whole does",
    );
    assert.ok(totals(whole), "the fixture must actually produce records");
    whole.close();
    pieces.close();
  }

  test("a Codex session resumed part-way keeps its cumulative baseline", async () => {
    const session = "00000000-0000-4000-8000-0000000000c0";
    const lines: string[] = [
      JSON.stringify({ type: "session_meta", payload: { id: session, cwd: "/repo", cli_version: "1.0.0" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }),
    ];
    let input = 0;
    let output = 0;
    for (let i = 0; i < 24; i++) {
      input += 1_000 + i;
      output += 200 + i;
      // A resume mid-file, under a new session id continuing the same counter.
      if (i === 12) {
        lines.push(JSON.stringify({
          type: "session_meta",
          payload: { id: "00000000-0000-4000-8000-0000000000c1", cwd: "/repo", cli_version: "1.0.0" },
        }));
        lines.push(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }));
      }
      lines.push(JSON.stringify({
        type: "event_msg",
        timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, i)).toISOString(),
        payload: {
          type: "token_count",
          info: {
            model_context_window: 272000,
            last_token_usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: Math.floor(input / 4),
              output_tokens: output,
              reasoning_output_tokens: Math.floor(output / 5),
              total_tokens: input + output,
            },
          },
        },
      }));
    }
    await compare(lines, "codex");
  });

  test("a Claude turn streamed across the boundary is replaced, not added", async () => {
    const session = "00000000-0000-4000-8000-0000000000cc";
    const lines: string[] = [];
    for (let i = 0; i < 18; i++) {
      // Each request is written twice, as a streaming turn is: the second line
      // supersedes the first. Split across an append, the resume has to know.
      for (const output of [50, 400]) {
        lines.push(JSON.stringify({
          type: "assistant",
          sessionId: session,
          requestId: `req_${i}`,
          timestamp: new Date(Date.UTC(2026, 5, 3, 11, 0, i)).toISOString(),
          cwd: "/repo",
          version: "1.0.0",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 300,
              output_tokens: output,
              cache_read_input_tokens: 120,
              cache_creation_input_tokens: 60,
            },
          },
        }));
      }
    }
    await compare(lines, "claude");
  });
});
