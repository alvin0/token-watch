import * as assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { CodexParser } from "../../worker/parsers/codex.js";
import { ClaudeParser } from "../../worker/parsers/claude.js";
import type { ParseOutput } from "../../worker/parsers/types.js";
import { ingestFile, isPartialIngestError } from "../../worker/ingest.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import type { CandidateFile } from "../../worker/discovery.js";

const SESSION = "00000000-0000-4000-8000-0000000000aa";

function codexLines(turns: number): string {
  const lines: string[] = [
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: "/repo", cli_version: "1.0.0" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } }),
  ];
  let total = 0;
  for (let index = 0; index < turns; index++) {
    total += 100;
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, index)).toISOString(),
      payload: {
        type: "token_count",
        info: {
          model_context_window: 272000,
          last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          total_token_usage: {
            input_tokens: total,
            cached_input_tokens: 0,
            output_tokens: total / 5,
            reasoning_output_tokens: 0,
            total_tokens: total + total / 5,
          },
        },
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}

function claudeLines(turns: number): string {
  const lines: string[] = [];
  for (let index = 0; index < turns; index++) {
    lines.push(JSON.stringify({
      type: "assistant",
      sessionId: SESSION,
      requestId: `req_${index}`,
      timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, index)).toISOString(),
      cwd: "/repo",
      version: "1.0.0",
      message: {
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}

async function collect(
  parser: CodexParser | ClaudeParser,
  filePath: string,
  checkpointTurns?: number,
): Promise<ParseOutput[]> {
  const batches: ParseOutput[] = [];
  await parser.parse(
    {
      filePath,
      fileId: "file:1",
      startOffset: 0,
      endOffset: statSync(filePath).size,
      maxLineBytes: 1_048_576,
      ...(checkpointTurns === undefined ? {} : { checkpointTurns }),
    },
    (batch) => batches.push(batch),
  );
  return batches;
}

suite("Parser checkpointing", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-checkpoint-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("without a checkpoint the Codex parser still emits one batch", async () => {
    const file = join(dir, "codex.jsonl");
    writeFileSync(file, codexLines(40), "utf8");
    const batches = await collect(new CodexParser(), file);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].rawTurns.length, 40);
  });

  test("Codex checkpoints split the turns without losing or duplicating any", async () => {
    const file = join(dir, "codex.jsonl");
    writeFileSync(file, codexLines(40), "utf8");

    const single = await collect(new CodexParser(), file);
    const batched = await collect(new CodexParser(), file, 10);

    assert.ok(batched.length > 1, `expected several batches, got ${batched.length}`);
    const batchedTurns = batched.flatMap((batch) => batch.rawTurns);
    assert.strictEqual(batchedTurns.length, single[0].rawTurns.length);
    assert.deepStrictEqual(
      batchedTurns.map((turn) => turn.dedupKey),
      single[0].rawTurns.map((turn) => turn.dedupKey),
      "Checkpointing must not change which turns are produced",
    );
  });

  test("every Codex checkpoint ends on a resumable byte boundary", async () => {
    const file = join(dir, "codex.jsonl");
    const content = codexLines(40);
    writeFileSync(file, content, "utf8");

    const batched = await collect(new CodexParser(), file, 10);
    const size = statSync(file).size;
    let previous = 0;
    for (const batch of batched) {
      assert.ok(batch.endOffset > previous, "Offsets must advance");
      assert.ok(batch.endOffset <= size);
      // A resumable boundary is the start of a line.
      assert.ok(
        batch.endOffset === size || content[batch.endOffset - 1] === "\n",
        `endOffset ${batch.endOffset} is mid-line`,
      );
      previous = batch.endOffset;
    }
    assert.strictEqual(previous, size, "The last batch must reach the end of the file");
  });

  test("Claude checkpoints split the turns without losing or duplicating any", async () => {
    const file = join(dir, "claude.jsonl");
    writeFileSync(file, claudeLines(30), "utf8");

    const single = await collect(new ClaudeParser(), file);
    const batched = await collect(new ClaudeParser(), file, 8);

    assert.ok(batched.length > 1, `expected several batches, got ${batched.length}`);
    assert.deepStrictEqual(
      batched.flatMap((batch) => batch.rawTurns).map((turn) => turn.dedupKey),
      single[0].rawTurns.map((turn) => turn.dedupKey),
    );
  });
});

suite("Checkpointed ingestion", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-checkpoint-ingest-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a checkpointed file ingests to the same totals as an un-checkpointed one", async () => {
    const SQL = await initSqlJs();
    const file = join(dir, "codex.jsonl");
    // Well over CHECKPOINT_TURNS so the batch path is really exercised.
    writeFileSync(file, codexLines(12_000), "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file,
      source: "codex",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: "codex:1",
    };

    const store = new UsageStore();
    await store.open(join(dir, "db.sqlite"), SQL);
    await store.migrateOrRebuild();
    const pricing = new PricingEngine({}, undefined);

    const result = await ingestFile(candidate, store, pricing, { maxLineBytes: 1_048_576, backfillMonths: 0 });
    assert.strictEqual(result.decision, "firstRead");
    assert.strictEqual(store.usageRecordCount(), 12_000, "Every turn must be committed exactly once");

    // The cursor must describe the whole file, so the next scan skips it.
    const cursor = store.getCursor(file);
    assert.ok(cursor);
    assert.strictEqual(cursor.lastByteOffset, stat.size);
    assert.strictEqual(cursor.size, stat.size);

    const again = await ingestFile(candidate, store, pricing, { maxLineBytes: 1_048_576, backfillMonths: 0 });
    assert.strictEqual(again.decision, "skip", "A fully ingested file must not be re-read");
    assert.strictEqual(store.usageRecordCount(), 12_000, "Re-scanning must not duplicate rows");
    store.close();
  });
});


suite("Checkpoint durability", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-durable-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("progress is persisted mid-scan, not only when the scan ends", async () => {
    const SQL = await initSqlJs();
    const file = join(dir, "codex.jsonl");
    writeFileSync(file, codexLines(12_000), "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file,
      source: "codex",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: "codex:1",
    };

    const dbPath = join(dir, "db.sqlite");
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    const pricing = new PricingEngine({}, undefined);

    let checkpoints = 0;
    let persistedMidScan = false;
    await ingestFile(candidate, store, pricing, {
      maxLineBytes: 1_048_576,
      backfillMonths: 0,
      onCheckpoint: () => {
        checkpoints++;
        // The worker throttles this by time; here every checkpoint writes, so
        // the assertion is about durability rather than the throttle.
        store.flush();
        if (!persistedMidScan && existsSync(dbPath)) {
          persistedMidScan = true;
        }
      },
    });

    assert.ok(checkpoints > 1, `A 12k-turn file should checkpoint repeatedly, got ${checkpoints}`);
    assert.ok(persistedMidScan, "The database should exist on disk before the scan finished");

    // What is on disk is a real, resumable database.
    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    assert.strictEqual(reopened.usageRecordCount(), 12_000);
    const cursor = reopened.getCursor(file);
    assert.ok(cursor, "The persisted snapshot must carry the file cursor");
    assert.strictEqual(cursor.lastByteOffset, stat.size);
    reopened.close();
    store.close();
  });

  test("an interrupted scan leaves a resumable cursor rather than nothing", async () => {
    const SQL = await initSqlJs();
    const file = join(dir, "codex.jsonl");
    writeFileSync(file, codexLines(12_000), "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file,
      source: "codex",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: "codex:1",
    };

    const dbPath = join(dir, "db.sqlite");
    const store = new UsageStore();
    await store.open(dbPath, SQL);
    await store.migrateOrRebuild();
    const pricing = new PricingEngine({}, undefined);

    // Persist the first checkpoint, then stop as a crash would.
    let stopped = false;
    class Interrupted extends Error {}
    try {
      await ingestFile(candidate, store, pricing, {
        maxLineBytes: 1_048_576,
        backfillMonths: 0,
        onCheckpoint: () => {
          if (stopped) { return; }
          stopped = true;
          store.flush();
          throw new Interrupted("simulated shutdown");
        },
      });
      assert.fail("The interruption should have propagated");
    } catch (error) {
      // Wrapped, because batches were already committed: the caller has to be
      // able to tell "nothing happened" from "something happened then broke".
      assert.ok(isPartialIngestError(error), String(error));
      assert.ok(error.committedBatches > 0);
      assert.ok(error.cause instanceof Interrupted, String(error.cause));
    }

    const reopened = new UsageStore();
    await reopened.open(dbPath, SQL);
    const recovered = reopened.usageRecordCount();
    assert.ok(recovered > 0, "The checkpoint before the interruption must survive");
    assert.ok(recovered < 12_000, "Only the committed prefix should be present");
    const cursor = reopened.getCursor(file);
    assert.ok(cursor, "A resumable cursor must be persisted with it");
    assert.ok(
      cursor.lastByteOffset > 0 && cursor.lastByteOffset < stat.size,
      "The cursor should sit part-way through the file",
    );
    assert.strictEqual(
      cursor.size,
      cursor.lastByteOffset,
      "A mid-file cursor records how far it got, so the next scan appends instead of skipping",
    );
    reopened.close();
    store.close();
  });
});
