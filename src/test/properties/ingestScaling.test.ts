import * as assert from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

import { CHECKPOINT_TURNS, ingestAll, ingestFile } from "../../worker/ingest.js";
import { UsageStore } from "../../worker/store/UsageStore.js";
import { PricingEngine } from "../../worker/pricing.js";
import { mergePricingConfig } from "../../shared/pricingMerge.js";
import { aggregateIntegrity, rebuildAggregates } from "../../worker/store/queries.js";
import type { CandidateFile } from "../../worker/discovery.js";

const SESSION = "00000000-0000-4000-8000-0000000000cc";

/**
 * Turns with growing cumulative input, so the session crosses the long-context
 * threshold partway through. That crossing is what makes per-batch re-pricing
 * observable: costs written by an early batch have to be revised later.
 */
function codexLines(turns: number, model = "gpt-5-codex"): string {
  const lines: string[] = [
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: "/repo", cli_version: "1.0.0" } }),
    JSON.stringify({ type: "turn_context", payload: { model, effort: "medium" } }),
  ];
  let total = 0;
  for (let index = 0; index < turns; index++) {
    total += 500;
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: new Date(Date.UTC(2026, 5, 3, 10, 0, index % 60)).toISOString(),
      payload: {
        type: "token_count",
        info: {
          model_context_window: 272000,
          last_token_usage: { input_tokens: total, output_tokens: 100, total_tokens: total + 100 },
          total_token_usage: {
            input_tokens: total,
            cached_input_tokens: Math.floor(total / 4),
            output_tokens: total / 5,
            reasoning_output_tokens: total / 10,
            total_tokens: total + total / 5,
          },
        },
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}

function snapshot(store: UsageStore): string {
  const daily = store.database.exec(
    `SELECT day_local, source, variant_id, base_model, workspace,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            reasoning_tokens, total_tokens, turns, ROUND(cost_usd, 9), unknown_cost_turns
     FROM daily_aggregate ORDER BY day_local, source, variant_id, workspace`,
  );
  const sessions = store.database.exec(
    `SELECT source, session_id, workspace, first_ts_utc, last_ts_utc, turns,
            total_tokens, ROUND(cost_usd, 9), sidechain_tokens
     FROM session_aggregate ORDER BY source, session_id`,
  );
  return JSON.stringify({ daily: daily[0]?.values ?? [], sessions: sessions[0]?.values ?? [] });
}

suite("Checkpointed ingest stays canonical", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-scaling-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function ingest(name: string, turns: number) {
    const SQL = await initSqlJs();
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, codexLines(turns), "utf8");
    const stat = statSync(file);
    const candidate: CandidateFile = {
      filePath: file,
      source: "codex",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fileId: `f:${name}`,
    };
    const store = new UsageStore();
    await store.open(join(dir, `${name}.db`), SQL);
    await store.migrateOrRebuild();
    const merged = mergePricingConfig({});
    const pricing = new PricingEngine(merged.table, merged.fallbackRate);
    const started = Date.now();
    await ingestFile(candidate, store, pricing, { maxLineBytes: 1_048_576, backfillMonths: 0 });
    return { store, pricing, ms: Date.now() - started };
  }

  test("a multi-batch file produces the same aggregates as a full rebuild", async function () {
    this.timeout(60_000);
    // Comfortably over CHECKPOINT_TURNS, so the deferred path really runs.
    const { store, pricing } = await ingest("multi", CHECKPOINT_TURNS * 3);

    const incremental = snapshot(store);
    assert.ok(
      aggregateIntegrity(store.database).valid,
      "Incrementally maintained aggregates must already agree with the records",
    );

    // The canonical recomputation must change nothing.
    rebuildAggregates(store.database, pricing);
    assert.strictEqual(
      snapshot(store),
      incremental,
      "Deferring the rebuild to the final batch must not change a single aggregate row",
    );
    store.close();
  });

  test("a single-batch file is unaffected by the deferral", async function () {
    this.timeout(60_000);
    const { store, pricing } = await ingest("single", Math.floor(CHECKPOINT_TURNS / 2));
    const incremental = snapshot(store);
    rebuildAggregates(store.database, pricing);
    assert.strictEqual(snapshot(store), incremental);
    store.close();
  });

  test("an empty-store bulk load rebuilds canonical derived rows once at the end", async function () {
    this.timeout(60_000);
    const SQL = await initSqlJs();
    const candidates: CandidateFile[] = [];
    for (const name of ["bulk-a", "bulk-b"]) {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, codexLines(1_000), "utf8");
      const stat = statSync(file);
      candidates.push({
        filePath: file,
        source: "codex",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileId: `f:${name}`,
      });
    }

    const store = new UsageStore();
    await store.open(join(dir, "bulk.db"), SQL);
    await store.migrateOrRebuild();
    const merged = mergePricingConfig({});
    const pricing = new PricingEngine(merged.table, merged.fallbackRate);

    const result = await ingestAll(candidates, store, pricing, {
      maxLineBytes: 1_048_576,
      backfillMonths: 0,
      deferDerivedUntilEnd: true,
    });

    assert.strictEqual(result.firstReads, 2);
    assert.strictEqual(store.usageRecordCount(), 2_000);
    assert.ok(aggregateIntegrity(store.database).valid, "Bulk load must return with canonical aggregates");
    const incremental = snapshot(store);
    rebuildAggregates(store.database, pricing);
    assert.strictEqual(snapshot(store), incremental, "The final rebuild must already be canonical");
    store.close();
  });

  test("stored totals equal the sum of the records they came from", async function () {
    this.timeout(60_000);
    const { store } = await ingest("totals", CHECKPOINT_TURNS * 2);

    const fromRecords = store.database.exec("SELECT SUM(total_tokens) FROM usage_record")[0].values[0][0];
    const fromAggregate = store.database.exec("SELECT SUM(total_tokens) FROM daily_aggregate")[0].values[0][0];
    assert.strictEqual(
      Number(fromAggregate),
      Number(fromRecords),
      "The dashboard reads daily_aggregate; it must not over-count against usage_record",
    );

    const records = store.database.exec("SELECT COUNT(*) FROM usage_record")[0].values[0][0];
    assert.strictEqual(Number(records), CHECKPOINT_TURNS * 2, "Every turn is stored exactly once");
    store.close();
  });

  test("each record is re-priced once per file, not once per batch", async function () {
    // The regression this guards: rebuilding derived rows on every checkpoint
    // re-read and re-priced the WHOLE session each time, so the work was
    // O(batches x records) and a large log took minutes. Counting the pricing
    // calls measures that directly, without depending on machine speed.
    this.timeout(120_000);
    const SQL = await initSqlJs();
    const turns = CHECKPOINT_TURNS * 4;
    const file = join(dir, "counted.jsonl");
    writeFileSync(file, codexLines(turns), "utf8");
    const stat = statSync(file);
    const store = new UsageStore();
    await store.open(join(dir, "counted.db"), SQL);
    await store.migrateOrRebuild();

    const merged = mergePricingConfig({});
    const pricing = new PricingEngine(merged.table, merged.fallbackRate);
    let priced = 0;
    const realCostOfAggregate = pricing.costOfAggregate.bind(pricing);
    pricing.costOfAggregate = ((...args: Parameters<PricingEngine["costOfAggregate"]>) => {
      priced++;
      return realCostOfAggregate(...args);
    }) as PricingEngine["costOfAggregate"];

    await ingestFile(
      { filePath: file, source: "codex", size: stat.size, mtimeMs: stat.mtimeMs, fileId: "f:counted" },
      store,
      pricing,
      { maxLineBytes: 1_048_576, backfillMonths: 0 },
    );

    // Each record is priced when its batch is built, and once more by the
    // single end-of-file rebuild. Anything proportional to batch COUNT means
    // the per-checkpoint rebuild is back.
    const batches = Math.ceil(turns / CHECKPOINT_TURNS);
    assert.ok(batches >= 4, `Expected several batches, got ${batches}`);
    assert.ok(
      priced <= turns * 3,
      `Priced ${priced} times for ${turns} turns across ${batches} batches — ` +
      "that scales with batch count, so the derived rebuild is running per checkpoint again",
    );
    assert.strictEqual(store.usageRecordCount(), turns);
    store.close();
  });
});
