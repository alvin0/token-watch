import * as assert from "assert";
import initSqlJs, { Database } from "sql.js";

import { buildDiagnosticsReport } from "../../worker/diagnostics.js";
import { PricingEngine } from "../../worker/pricing.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../worker/store/schema.js";
import type { FileContribution } from "../../shared/storeTypes.js";
import type { PricingDiagnostics } from "../../shared/protocol.js";

suite("Diagnostics report tests", () => {
  test("Reports pricing audit, long-context gaps, midnight sessions, folder-day drift, and reconciliation mismatches", async () => {
    const db = await freshDb();
    const audit: PricingDiagnostics = {
      ignoredKnownModelOverrides: ["gpt-5"],
      ignoredFallbackOverride: true,
      customModelOverrides: ["custom-large"],
    };
    const pricing = new PricingEngine({
      "custom-large": { inputPer1K: 0.01, outputPer1K: 0.02 },
    });
    const firstTs = new Date("2026-06-07T23:50:00").getTime();
    const lastTs = new Date("2026-06-08T00:10:00").getTime();

    insertUsageRecord(db, {
      dedupKey: "codex:diag-session:1",
      fileId: "diag-file",
      sessionId: "diag-session",
      ts: firstTs,
      model: "custom-large",
      inputTokens: 100,
      outputTokens: 50,
      contextUsedTokens: 300_000,
    });
    db.run(
      `INSERT INTO session_aggregate
       (source, session_id, workspace, first_ts_utc, last_ts_utc, turns, total_tokens, cost_usd, sidechain_tokens)
       VALUES ('codex', 'diag-session', '', ?, ?, 1, 150, 1.23, 0)`,
      [firstTs, lastTs],
    );
    const contribution: FileContribution = {
      daily: [{
        day: "2026-06-08",
        source: "codex",
        variantId: "custom-large",
        workspace: "",
        sums: {
          inputTokens: 90,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
        turns: 1,
        costUsd: 1.23,
        unknownTurns: 0,
      }],
      sessions: [{
        source: "codex",
        sessionId: "diag-session",
        sums: {
          inputTokens: 90,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
        turns: 1,
        costUsd: 1.23,
        firstTsUtc: firstTs,
        lastTsUtc: lastTs,
        sidechainTokens: 0,
      }],
      recordKeys: ["codex:diag-session:1"],
      toolEventCount: 0,
    };
    db.run(
      `INSERT INTO file_cursor
       (file_path, file_id, source, size, mtime_ms, last_byte_offset, head_hash, tail_anchor_hash,
        running_totals, recent_req_ids, contribution)
       VALUES (?, 'diag-file', 'codex', 100, 1, 100, 'head', 'tail', ?, '[]', ?)`,
      [
        "/tmp/.codex/sessions/2026/06/07/rollout-diag.jsonl",
        JSON.stringify({
          "diag-session": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          },
        }),
        JSON.stringify(contribution),
      ],
    );

    const report = buildDiagnosticsReport(db, pricing, audit);

    assert.deepStrictEqual(report.pricing, audit);
    assert.strictEqual(report.longContext.missingRates[0].model, "custom-large");
    assert.strictEqual(report.crossingMidnightSessions[0].sessionId, "diag-session");
    assert.strictEqual(report.folderDayMismatches[0].folderDay, "2026-06-07");
    assert.strictEqual(report.folderDayMismatches[0].eventDays[0], "2026-06-08");
    assert.strictEqual(report.reconciliation.checkedSessions, 1);
    assert.strictEqual(report.reconciliation.mismatches[0].deltaTokens, -10);
    db.close();
  });
});

async function freshDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
    String(SCHEMA_VERSION),
  ]);
  return db;
}

function insertUsageRecord(
  db: Database,
  record: {
    dedupKey: string;
    fileId: string;
    sessionId: string;
    ts: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    contextUsedTokens: number;
  },
): void {
  const day = localDay(new Date(record.ts));
  db.run(
    `INSERT INTO usage_record
     (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
      model, effort, variant_id, workspace,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      reasoning_tokens, total_tokens, context_window, context_used_tokens,
      is_sidechain, stop_reason)
     VALUES (?, ?, 'codex', ?, ?, ?, 0, 0, ?, 'n/a', ?, '',
      ?, ?, 0, 0, 0, ?, 1000000, ?, 0, NULL)`,
    [
      record.dedupKey,
      record.fileId,
      record.sessionId,
      record.ts,
      day,
      record.model,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.inputTokens + record.outputTokens,
      record.contextUsedTokens,
    ],
  );
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
