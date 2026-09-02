import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { ingestAll } from "../../worker/ingest.js";
import { aggregateIntegrity } from "../../worker/store/queries.js";
import type { CandidateFile } from "../../worker/discovery.js";

/**
 * What has to be true of every row the store holds, whatever the logs did.
 *
 * These are checked as a sweep rather than a case: each is a single query over
 * the whole table, so a fixture that trips any of them fails loudly instead of
 * quietly skewing a total. The same sweep run over 163,007 records parsed from
 * real logs found nothing, which is the standard this fixture has to keep.
 */
suite("Everything stored obeys the same rules", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });
  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-invariants-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  /**
   * Logs that exercise the awkward paths on purpose: a resumed Codex session, a
   * counter that restarts, a component that dips, cached exceeding input, and a
   * Claude turn streamed twice.
   */
  function awkwardLogs(): CandidateFile[] {
    const codexLines: string[] = [
      JSON.stringify({ type: "session_meta", payload: { id: "sess-a", cwd: "/repo", cli_version: "1.0.0" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }),
    ];
    const reading = (
      input: number, output: number, cached: number, reasoning: number, second: number,
    ): string => JSON.stringify({
      type: "event_msg",
      timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, second)).toISOString(),
      payload: {
        type: "token_count",
        info: {
          model_context_window: 272000,
          last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: input + output,
          },
        },
      },
    });

    codexLines.push(reading(1_000, 200, 100, 20, 1));
    codexLines.push(reading(5_000, 900, 400, 100, 2));
    // Resumed under a new id, continuing the same counter.
    codexLines.push(JSON.stringify({
      type: "session_meta", payload: { id: "sess-b", cwd: "/repo", cli_version: "1.0.0" },
    }));
    codexLines.push(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "high" } }));
    codexLines.push(reading(5_400, 1_100, 4_000, 300, 3));
    // Input dips while output rises.
    codexLines.push(reading(5_200, 2_000, 4_000, 400, 4));
    // The counter restarts outright.
    codexLines.push(reading(80, 10, 70, 5, 5));
    codexLines.push(reading(900, 300, 800, 90, 6));

    const claudeLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      for (const output of [40, 500]) {
        claudeLines.push(JSON.stringify({
          type: "assistant",
          sessionId: "00000000-0000-4000-8000-0000000000dd",
          requestId: `req_${i}`,
          timestamp: new Date(Date.UTC(2026, 5, 4, 12, 0, i)).toISOString(),
          cwd: "/repo",
          version: "1.0.0",
          message: {
            model: "claude-opus-5",
            content: [{ type: "tool_use", name: "Read", input: {} }],
            usage: {
              input_tokens: 250,
              output_tokens: output,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 30,
            },
          },
        }));
      }
    }

    const out: CandidateFile[] = [];
    for (const [name, lines, source] of [
      ["codex.jsonl", codexLines, "codex"],
      ["claude.jsonl", claudeLines, "claude"],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      const stat = statSync(file);
      out.push({ filePath: file, source, size: stat.size, mtimeMs: stat.mtimeMs, fileId: name });
    }
    return out;
  }

  async function seeded(): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();
    await ingestAll(awkwardLogs(), store, new PricingEngine({}, undefined), {
      maxLineBytes: 1_048_576, backfillMonths: 0,
    });
    return store;
  }

  const count = (store: UsageStore, sql: string): number =>
    Number(store.database.exec(sql)[0].values[0][0]);

  test("no row breaks a rule it should not be able to break", async () => {
    const store = await seeded();
    assert.ok(count(store, "SELECT COUNT(*) FROM usage_record") > 0, "the fixture must store something");

    const rules: Array<[string, string]> = [
      [
        "the five token buckets must sum to the total",
        `SELECT COUNT(*) FROM usage_record WHERE input_tokens + output_tokens + cache_read_tokens
         + cache_creation_tokens + reasoning_tokens != total_tokens`,
      ],
      [
        "no token count may be negative",
        `SELECT COUNT(*) FROM usage_record WHERE input_tokens < 0 OR output_tokens < 0
         OR cache_read_tokens < 0 OR cache_creation_tokens < 0 OR reasoning_tokens < 0 OR total_tokens < 0`,
      ],
      ["a turn that used nothing is not a turn", "SELECT COUNT(*) FROM usage_record WHERE total_tokens = 0"],
      ["every row needs a timestamp", "SELECT COUNT(*) FROM usage_record WHERE ts_utc <= 0"],
      [
        "the local day must follow from the timestamp",
        `SELECT COUNT(*) FROM usage_record
         WHERE day_local != strftime('%Y-%m-%d', ts_utc / 1000, 'unixepoch', 'localtime')`,
      ],
      ["a dedup key identifies one row", "SELECT COUNT(*) - COUNT(DISTINCT dedup_key) FROM usage_record"],
      [
        "a tool event must not outlive its turn",
        `SELECT COUNT(*) FROM tool_event t
         WHERE NOT EXISTS (SELECT 1 FROM usage_record r WHERE r.dedup_key = t.record_dedup_key)`,
      ],
      ["a model is always known by the time a row is written", "SELECT COUNT(*) FROM usage_record WHERE model = '' OR model = 'unknown'"],
    ];

    for (const [rule, sql] of rules) {
      assert.strictEqual(count(store, sql), 0, rule);
    }
    store.close();
  });

  test("the aggregates and the rows they came from report the same tokens", async () => {
    const store = await seeded();
    const records = count(store, "SELECT SUM(total_tokens) FROM usage_record");
    assert.ok(records > 0);
    assert.strictEqual(
      count(store, "SELECT SUM(total_tokens) FROM daily_aggregate"),
      records,
      "the day totals are what the dashboard draws",
    );
    assert.strictEqual(
      count(store, "SELECT SUM(total_tokens) FROM session_aggregate"),
      records,
      "and the session totals are the same tokens grouped differently",
    );
    assert.strictEqual(aggregateIntegrity(store.database).valid, true);
    store.close();
  });
});
