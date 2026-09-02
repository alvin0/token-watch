import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { ingestFile } from "../../worker/ingest.js";
import { toolCallsByDay, toolUsage } from "../../worker/store/queries.js";
import type { AnalyticsQuery } from "../../shared/protocol.js";
import type { CandidateFile } from "../../worker/discovery.js";

/**
 * The tool tables carry their own day and source, and are indexed on the pair,
 * so the dashboard reads them without joining `usage_record`. That shortcut is
 * only sound while both tables agree, which is what these check.
 *
 * The join cost 77 ms per query on a real database and the two tool queries
 * between them were 87% of the time the dashboard spent reading; going direct
 * took the whole dashboard query from 176 ms to 36 ms.
 */
suite("Tool queries read the tool tables directly", () => {
  let dir: string;
  let SQL: initSqlJs.SqlJsStatic;

  suiteSetup(async () => { SQL = await initSqlJs(); });
  setup(() => { dir = mkdtempSync(join(tmpdir(), "token-watch-tools-")); });
  teardown(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A Claude session whose assistant turns call tools. */
  function claudeLog(days: string[]): string {
    const lines: string[] = [];
    days.forEach((day, index) => {
      lines.push(JSON.stringify({
        type: "assistant",
        sessionId: "00000000-0000-4000-8000-0000000000aa",
        requestId: `req_${index}`,
        timestamp: `${day}T10:00:0${index % 10}.000Z`,
        cwd: "/repo",
        version: "1.0.0",
        message: {
          model: "claude-opus-5",
          content: [
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Edit", input: {} },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }));
    });
    const file = join(dir, "claude.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    return file;
  }

  async function seed(): Promise<UsageStore> {
    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();
    const file = claudeLog([
      "2026-06-01", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-03", "2026-06-04",
    ]);
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file, source: "claude", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "claude:1",
    };
    await ingestFile(candidate, store, new PricingEngine({}, undefined), {
      maxLineBytes: 1_048_576, backfillMonths: 0,
    });
    return store;
  }

  const range = { fromUtc: Date.parse("2026-05-01T00:00:00Z"), toUtc: Date.parse("2026-07-01T00:00:00Z") };

  test("the two tables never disagree about a call's day or source", async () => {
    // The shortcut rests on this. If a tool event could carry a different day
    // from the turn it belongs to, the direct read would file it under the
    // wrong one and the join would not.
    const store = await seed();
    const mismatched = Number(store.database.exec(
      `SELECT COUNT(*) FROM tool_event t JOIN usage_record r ON r.dedup_key = t.record_dedup_key
       WHERE t.day_local != r.day_local OR t.source != r.source`,
    )[0].values[0][0]);
    assert.strictEqual(mismatched, 0, "every tool event must agree with its turn");

    const orphans = Number(store.database.exec(
      `SELECT COUNT(*) FROM tool_event t
       WHERE NOT EXISTS (SELECT 1 FROM usage_record r WHERE r.dedup_key = t.record_dedup_key)`,
    )[0].values[0][0]);
    assert.strictEqual(orphans, 0, "a tool event must not outlive the turn it came from");
    store.close();
  });

  test("the direct read and the join report the same calls", async () => {
    const store = await seed();
    const direct: AnalyticsQuery = {
      view: "tools", granularity: "day", range, sources: ["claude"],
    } as AnalyticsQuery;
    // A workspace filter forces the join, because `tool_event` does not carry a
    // usable workspace. It has to be the real one, or the join would be compared
    // against an empty result and prove nothing.
    const workspace = String(store.database.exec(
      "SELECT DISTINCT workspace FROM usage_record",
    )[0].values[0][0]);
    const joined = { ...direct, workspaces: [workspace] } as AnalyticsQuery;

    assert.deepStrictEqual(
      toolUsage(store.database, direct),
      toolUsage(store.database, joined),
      "the shortcut must not change what the tool table reports",
    );
    assert.deepStrictEqual(
      toolCallsByDay(store.database, direct),
      toolCallsByDay(store.database, joined),
      "nor how the calls fall across days",
    );
    store.close();
  });

  test("the calls are actually there, so the comparison means something", async () => {
    const store = await seed();
    const q = { view: "tools", granularity: "day", range, sources: ["claude"] } as AnalyticsQuery;
    const usage = toolUsage(store.database, q);
    const total = usage.reduce((sum, row) => sum + row.count, 0);
    assert.strictEqual(total, 12, "six turns calling two tools each");
    assert.deepStrictEqual(
      usage.map((row) => row.toolName).sort(),
      ["Edit", "Read"],
      "both tools should be counted",
    );
    assert.strictEqual(toolCallsByDay(store.database, q).length, 4, "four distinct days");
    store.close();
  });

  test("a model filter still goes through the join, because it has to", async () => {
    // `tool_event` stores no usable model, so a query that filters on one
    // cannot take the shortcut. It must still return the right answer.
    const store = await seed();
    const q = {
      view: "tools", granularity: "day", range, sources: ["claude"], models: ["claude-opus-5"],
    } as AnalyticsQuery;
    const total = toolUsage(store.database, q).reduce((sum, row) => sum + row.count, 0);
    assert.strictEqual(total, 12, "the join path must find the same calls");

    const none = {
      view: "tools", granularity: "day", range, sources: ["claude"], models: ["not-a-model"],
    } as AnalyticsQuery;
    assert.strictEqual(
      toolUsage(store.database, none).reduce((sum, row) => sum + row.count, 0),
      0,
      "and must still filter",
    );
    store.close();
  });
});
