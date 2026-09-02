import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { readLines } from "../../worker/parsers/lineReader.js";
import { ClaudeParser } from "../../worker/parsers/claude.js";
import { CodexParser } from "../../worker/parsers/codex.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import { ingestFile } from "../../worker/ingest.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { warnings } from "../../worker/store/queries.js";
import { buildDiagnosticsReport } from "../../worker/diagnostics.js";
import type { CandidateFile } from "../../worker/discovery.js";

const SESSION = "00000000-0000-4000-8000-0000000000ee";

/** An assistant turn whose tool_use writes a large file: long, and it has usage. */
function hugeAssistantLine(padBytes: number, requestId: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SESSION,
    requestId,
    timestamp: "2026-06-03T10:00:00.000Z",
    cwd: "/repo",
    version: "1.0.0",
    message: {
      model: "claude-sonnet-4",
      content: [{ type: "tool_use", name: "Write", input: { content: "x".repeat(padBytes) } }],
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

/** A user turn carrying a large tool result: long, and it has no usage at all. */
function hugeUserLine(padBytes: number): string {
  return JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: "2026-06-03T10:00:00.000Z",
    message: { content: [{ type: "tool_result", content: "y".repeat(padBytes) }] },
  });
}

function smallAssistantLine(requestId: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SESSION,
    requestId,
    timestamp: "2026-06-03T10:00:01.000Z",
    cwd: "/repo",
    version: "1.0.0",
    message: {
      model: "claude-sonnet-4",
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

suite("Oversized lines are classified, not assumed lost", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-oversized-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a long line with no token data is skipped and reported as harmless", async () => {
    const file = join(dir, "user.jsonl");
    writeFileSync(file, `${hugeUserLine(4096)}\n`, "utf8");

    const stats = await readLines(
      { filePath: file, startOffset: 0, maxLineBytes: 1024, usageMarkers: ['"usage"'] },
      () => { assert.fail("A line with no usage should not be parsed"); },
    );
    assert.strictEqual(stats.oversizedSkippedCount, 1);
    assert.strictEqual(stats.oversizedRecoveredCount, 0);
    assert.strictEqual(stats.oversizedLostUsageCount, 0, "Nothing countable was in it");
  });

  test("a long line that carries token data is parsed anyway", async () => {
    const file = join(dir, "assistant.jsonl");
    writeFileSync(file, `${hugeAssistantLine(4096, "req_1")}\n`, "utf8");

    const seen: string[] = [];
    const stats = await readLines(
      { filePath: file, startOffset: 0, maxLineBytes: 1024, usageMarkers: ['"usage"'] },
      (line) => { seen.push(line); },
    );
    assert.strictEqual(seen.length, 1, "The line must still reach the parser");
    assert.strictEqual(stats.oversizedRecoveredCount, 1);
    assert.strictEqual(stats.oversizedSkippedCount, 0);
    assert.strictEqual(stats.oversizedLostUsageCount, 0);
  });

  test("a line past the hard ceiling is reported as a real loss", async () => {
    const file = join(dir, "enormous.jsonl");
    writeFileSync(file, `${hugeAssistantLine(64 * 1024, "req_1")}\n`, "utf8");

    const stats = await readLines(
      {
        filePath: file, startOffset: 0, maxLineBytes: 1024,
        usageMarkers: ['"usage"'], recoveryLimitBytes: 8 * 1024,
      },
      () => { assert.fail("A line past the ceiling cannot be parsed"); },
    );
    assert.strictEqual(stats.oversizedLostUsageCount, 1, "This one really does lose tokens");
    assert.strictEqual(stats.oversizedSkippedCount, 0);
  });

  test("a marker split across read chunks is still found", async () => {
    // The reader works in 256 KB chunks; a marker straddling a boundary must
    // not make a usage-bearing line look harmless.
    const file = join(dir, "straddle.jsonl");
    const padded = hugeAssistantLine(700 * 1024, "req_1");
    writeFileSync(file, `${padded}\n`, "utf8");

    const stats = await readLines(
      {
        filePath: file, startOffset: 0, maxLineBytes: 1024,
        usageMarkers: ['"usage"'], recoveryLimitBytes: 4096,
      },
      () => { /* too large to parse; only the classification matters here */ },
    );
    assert.strictEqual(stats.oversizedLostUsageCount, 1, "The marker must be found mid-stream");
  });

  test("ordinary lines around an oversized one are unaffected", async () => {
    const file = join(dir, "mixed.jsonl");
    writeFileSync(
      file,
      [smallAssistantLine("req_1"), hugeUserLine(4096), smallAssistantLine("req_2")].join("\n") + "\n",
      "utf8",
    );

    const seen: string[] = [];
    const stats = await readLines(
      { filePath: file, startOffset: 0, maxLineBytes: 1024, usageMarkers: ['"usage"'] },
      (line) => { seen.push(line); },
    );
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(stats.oversizedSkippedCount, 1);
  });
});

suite("Oversized usage lines reach the totals", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-oversized-ingest-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function collect(parser: ClaudeParser | CodexParser, file: string, maxLineBytes: number) {
    const batches: ParseOutput[] = [];
    await parser.parse(
      { filePath: file, fileId: "f:1", startOffset: 0, endOffset: statSync(file).size, maxLineBytes },
      (batch) => batches.push(batch),
    );
    return batches;
  }

  test("a Claude turn that writes a large file still contributes its tokens", async () => {
    // 2 MB of tool_use input, well past the 1 MB default — exactly the shape
    // that used to be dropped, taking 3000 tokens with it.
    const file = join(dir, "claude.jsonl");
    writeFileSync(file, `${hugeAssistantLine(2 * 1024 * 1024, "req_1")}\n`, "utf8");

    const [batch] = await collect(new ClaudeParser(), file, 1024 * 1024);
    assert.strictEqual(batch.rawTurns.length, 1, "The turn must be parsed despite its length");
    assert.strictEqual(batch.oversizedRecoveredCount, 1);
    assert.strictEqual(batch.oversizedCount, 0);
    assert.strictEqual(batch.oversizedLostUsageCount, 0);
  });

  test("those tokens are in the stored totals, and nothing is reported as lost", async () => {
    const SQL = await initSqlJs();
    const file = join(dir, "claude2.jsonl");
    writeFileSync(
      file,
      [hugeAssistantLine(2 * 1024 * 1024, "req_1"), hugeUserLine(2 * 1024 * 1024), smallAssistantLine("req_2")]
        .join("\n") + "\n",
      "utf8",
    );
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file, source: "claude", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "claude:1",
    };

    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();
    const result = await ingestFile(candidate, store, new PricingEngine({}, undefined), {
      maxLineBytes: 1024 * 1024,
      backfillMonths: 0,
    });

    assert.strictEqual(store.usageRecordCount(), 2, "Both assistant turns must be stored");
    const total = store.database.exec("SELECT SUM(total_tokens) FROM usage_record")[0].values[0][0];
    // 1000 + 2000 from the huge turn, 10 + 20 from the small one.
    assert.strictEqual(Number(total), 3030, "The huge turn's tokens must be in the total");

    assert.strictEqual(result.oversizedRecoveredCount, 1, "The assistant line was recovered");
    assert.strictEqual(result.oversizedCount, 1, "The user line was skipped, carrying nothing");
    assert.strictEqual(result.oversizedLostUsageCount, 0, "Nothing was actually lost");

    store.updateMetaCounts(0, result.oversizedCount, result.oversizedLostUsageCount);
    const reported = warnings(store.database);
    assert.strictEqual(reported.oversizedLineCount, 1);
    assert.strictEqual(
      reported.lostUsageLineCount,
      0,
      "The panel must be able to say the totals are complete",
    );
    store.close();
  });

  test("a Codex token_count line is recovered even if the line is huge", async () => {
    const file = join(dir, "codex.jsonl");
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: "/repo", cli_version: "1.0.0" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-03T10:00:00.000Z",
        payload: {
          type: "token_count",
          // Padding stands in for whatever else a real line might carry.
          note: "z".repeat(2 * 1024 * 1024),
          info: {
            model_context_window: 272000,
            last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            total_token_usage: {
              input_tokens: 100, cached_input_tokens: 0, output_tokens: 20,
              reasoning_output_tokens: 0, total_tokens: 120,
            },
          },
        },
      }),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const [batch] = await collect(new CodexParser(), file, 1024 * 1024);
    assert.strictEqual(batch.rawTurns.length, 1, "The token_count line must not be dropped for being long");
    assert.strictEqual(batch.oversizedRecoveredCount, 1);
    assert.strictEqual(batch.oversizedLostUsageCount, 0);
  });
});

suite("The panel only reports what changes the numbers", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-quiet-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a line still being written is not counted as one that could not be parsed", async () => {
    // A live session always ends mid-line. The reader leaves the cursor before
    // it so the next scan reads it whole — counting it meant an active session
    // permanently accused itself of dropping data.
    const complete = hugeAssistantLine(16, "req_1");
    const file = join(dir, "live.jsonl");
    // Cut inside the usage object so the line still matches the usage marker
    // and really does reach JSON.parse. A half line that lost the marker gets
    // filtered out earlier and would prove nothing.
    const half = complete.slice(0, complete.length - 12);
    writeFileSync(file, `${smallAssistantLine("req_0")}\n${half}`, "utf8");

    const batches: ParseOutput[] = [];
    await new ClaudeParser().parse(
      { filePath: file, fileId: "f:1", startOffset: 0, endOffset: statSync(file).size, maxLineBytes: 1024 * 1024 },
      (batch) => batches.push(batch),
    );

    const malformed = batches.reduce((sum, batch) => sum + batch.malformedCount, 0);
    assert.strictEqual(malformed, 0, "The half-written line is unfinished, not malformed");
    assert.strictEqual(batches.reduce((n, b) => n + b.rawTurns.length, 0), 1, "The finished turn still counts");
  });

  test("a full rescan clears every quality counter, including the loss ones", async () => {
    // These accumulate. Leaving the loss counters behind meant the warning the
    // user acted on stayed on screen after the rescan that fixed it.
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, "counters.sqlite"), SQL);
    await store.migrateOrRebuild();

    store.updateMetaCounts(3, 4, 5, 6);
    let reported = warnings(store.database);
    assert.strictEqual(reported.malformedLineCount, 3);
    assert.strictEqual(reported.lostUsageLineCount, 5);

    store.resetQualityCounters();
    reported = warnings(store.database);
    assert.strictEqual(reported.malformedLineCount, 0);
    assert.strictEqual(reported.oversizedLineCount, 0);
    assert.strictEqual(reported.lostUsageLineCount, 0, "A rescan must retract the loss warning too");
    store.close();
  });

  test("diagnostics states plainly whether any tokens are missing", async () => {
    const SQL = await initSqlJs();
    const store = new UsageStore();
    await store.open(join(dir, "diag.sqlite"), SQL);
    await store.migrateOrRebuild();

    // Long lines that held nothing countable, plus one recovered: no loss.
    store.updateMetaCounts(0, 32, 0, 2);
    const audit = { overriddenBundledModels: [], ignoredFallbackOverride: false, customModelOverrides: [] };
    let report = buildDiagnosticsReport(store.database, new PricingEngine({}, undefined), audit);
    assert.strictEqual(report.ingestion.oversizedLineCount, 32);
    assert.strictEqual(report.ingestion.oversizedRecoveredCount, 2);
    assert.strictEqual(
      report.ingestion.malformedLineCount + report.ingestion.lostUsageLineCount,
      0,
      "32 harmless long lines must not read as missing tokens",
    );

    store.updateMetaCounts(0, 0, 1, 0);
    report = buildDiagnosticsReport(store.database, new PricingEngine({}, undefined), audit);
    assert.strictEqual(report.ingestion.lostUsageLineCount, 1, "Real loss is still reported");
    store.close();
  });
});
