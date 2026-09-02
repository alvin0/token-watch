import { existsSync, readFileSync } from "node:fs";
import initSqlJs from "sql.js";

import { UsageStore } from "../out/worker/store/UsageStore.js";
import { AnalyticsService } from "../out/worker/analytics.js";
import { scan } from "../out/worker/discovery.js";
import { ingestAll } from "../out/worker/ingest.js";
import { CodexParser } from "../out/worker/parsers/codex.js";
import { ClaudeParser } from "../out/worker/parsers/claude.js";
import { aggregateIntegrity, rebuildAggregates } from "../out/worker/store/queries.js";
import { PricingEngine } from "../out/worker/pricing.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../out/worker/store/schema.js";
import { mergePricingConfig } from "../out/shared/pricingMerge.js";

const args = parseArgs(process.argv.slice(2));
const SQL = await initSqlJs();
const merged = mergePricingConfig({});
const pricing = new PricingEngine(merged.table, merged.fallbackRate);

if (args.fullIngest) {
  await benchmarkFullIngest(SQL, pricing, args);
  process.exit(0);
}
if (args.parseOnly) {
  await benchmarkParseOnly(args);
  process.exit(0);
}

const db = args.db
  ? new SQL.Database(readFileSync(args.db))
  : syntheticDatabase(SQL, 10_000);
const store = new UsageStore();
store.db = db;
await store.migrateOrRebuild();

const canonicalMs = elapsed(() => rebuildAggregates(db, pricing));
const targetedMs = elapsed(() => {
  const record = {
    source: "codex",
    sessionId: "benchmark-session",
    dedupKey: `benchmark:${Date.now()}`,
    timestamp: Date.now(),
    model: "gpt-5.4",
    variantId: "gpt-5.4",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
    reasoningTokens: 50,
  };
  store.commitFileResult(
    "benchmark-file",
    {
      records: [record],
      toolEvents: [],
      contribution: { daily: [], sessions: [], recordKeys: [record.dedupKey], toolEventCount: 0 },
    },
    "firstRead",
    pricing,
    {
      filePath: "/benchmark.jsonl", fileId: "benchmark-file", source: "codex",
      size: 1, mtimeMs: Date.now(), lastByteOffset: 1, headHash: "h", tailAnchorHash: "t",
      runningTotals: {}, recentRequestIds: [], parseRevision: 1,
      contribution: { daily: [], sessions: [], recordKeys: [record.dedupKey], toolEventCount: 0 },
    },
  );
});

const analytics = new AnalyticsService(db, pricing);
const now = new Date();
const fromUtc = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const query = { view: "dashboard", granularity: "day", range: { fromUtc, toUtc: fromUtc + 86_400_000 - 1 } };
const dashboardMs = median(Array.from({ length: 11 }, () => elapsed(() => analytics.query(query))));
const seriesMs = median(Array.from({ length: 11 }, () => elapsed(() => analytics.query({ ...query, view: "series" }))));

let discovery;
if (args.codexRoot || args.claudeRoot) {
  let candidates = [];
  const discoveryMs = elapsed(() => {
    candidates = scan({
      codex: args.codexRoot ? { enabled: true, path: args.codexRoot } : undefined,
      claude: args.claudeRoot ? { enabled: true, path: args.claudeRoot } : undefined,
    });
  });
  discovery = { ms: discoveryMs, candidates: candidates.length };
}

const integrityMsStart = performance.now();
const integrity = aggregateIntegrity(db);
const integrityMs = Number((performance.now() - integrityMsStart).toFixed(3));

console.log(JSON.stringify({
  source: args.db ? "database-copy" : "synthetic",
  rows: Number(db.exec("SELECT COUNT(*) FROM usage_record")[0].values[0][0]),
  canonicalMs,
  targetedMs,
  dashboardMedianMs: dashboardMs,
  seriesMedianMs: seriesMs,
  integrity,
  integrityMs,
  discovery,
}, null, 2));
db.close();

function syntheticDatabase(Sql, count) {
  const database = new Sql.Database();
  database.exec(SCHEMA_SQL);
  database.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  const insert = database.prepare(
    `INSERT INTO usage_record
     (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
      model, effort, variant_id, workspace, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, reasoning_tokens, total_tokens, is_sidechain, cost_usd, cost_unknown)
     VALUES (?, 'synthetic-file', 'codex', ?, ?, ?, 1, 10, 'gpt-5.4', 'n/a', 'gpt-5.4', '',
             100, 50, 25, 0, 10, 185, 0, 0, 0)`,
  );
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  database.run("BEGIN TRANSACTION");
  for (let index = 0; index < count; index++) {
    insert.run([`synthetic:${index}`, `session:${index % 100}`, Date.now() - index, day]);
  }
  database.run("COMMIT");
  insert.free();
  return database;
}

function elapsed(run) {
  const start = performance.now();
  run();
  return Number((performance.now() - start).toFixed(3));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const key = values[index];
    if (key === "--full-ingest") {
      result.fullIngest = true;
      continue;
    }
    if (key === "--parse-only") {
      result.parseOnly = true;
      continue;
    }
    const value = values[index + 1];
    if (!value) { continue; }
    if (key === "--db" && existsSync(value)) { result.db = value; }
    if (key === "--codex-root" && existsSync(value)) { result.codexRoot = value; }
    if (key === "--claude-root" && existsSync(value)) { result.claudeRoot = value; }
    if (key === "--max-ms" && Number.isFinite(Number(value))) { result.maxMs = Number(value); }
    if (key === "--max-line-bytes" && Number.isFinite(Number(value))) { result.maxLineBytes = Number(value); }
    index++;
  }
  return result;
}

async function benchmarkParseOnly(options) {
  const candidates = scan({
    codex: options.codexRoot ? { enabled: true, path: options.codexRoot } : undefined,
    claude: options.claudeRoot ? { enabled: true, path: options.claudeRoot } : undefined,
  });
  const parsers = { codex: new CodexParser(), claude: new ClaudeParser() };
  let rows = 0;
  let batches = 0;
  const started = performance.now();
  for (const candidate of candidates) {
    await parsers[candidate.source].parse({
      filePath: candidate.filePath,
      fileId: candidate.fileId,
      startOffset: 0,
      endOffset: candidate.size,
      maxLineBytes: 1_048_576,
      checkpointTurns: 5_000,
    }, (batch) => {
      rows += batch.rawTurns.length;
      batches++;
    });
  }
  console.log(JSON.stringify({
    source: "parse-only",
    candidates: candidates.length,
    sourceBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
    rows,
    batches,
    parseMs: Number((performance.now() - started).toFixed(3)),
  }, null, 2));
}

async function benchmarkFullIngest(Sql, pricingEngine, options) {
  const config = {
    codex: options.codexRoot ? { enabled: true, path: options.codexRoot } : undefined,
    claude: options.claudeRoot ? { enabled: true, path: options.claudeRoot } : undefined,
  };

  let candidates = [];
  const discoveryMs = elapsed(() => { candidates = scan(config); });
  const database = new Sql.Database();
  database.exec(SCHEMA_SQL);
  database.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  const benchmarkStore = new UsageStore();
  benchmarkStore.db = database;
  const realCommitFileResult = benchmarkStore.commitFileResult.bind(benchmarkStore);
  let commitMs = 0;
  let commitCalls = 0;
  benchmarkStore.commitFileResult = (...values) => {
    const started = performance.now();
    try {
      return realCommitFileResult(...values);
    } finally {
      commitMs += performance.now() - started;
      commitCalls++;
    }
  };

  const catalogMs = elapsed(() => benchmarkStore.recordDiscoveredFiles(candidates));
  const ingestStarted = performance.now();
  const result = await ingestAll(
    candidates,
    benchmarkStore,
    pricingEngine,
    { maxLineBytes: options.maxLineBytes ?? 1_048_576, backfillMonths: 0, deferDerivedUntilEnd: true },
  );
  const ingestMs = Number((performance.now() - ingestStarted).toFixed(3));
  let exportedBytes = 0;
  const exportMs = elapsed(() => { exportedBytes = database.export().byteLength; });
  const integrityStarted = performance.now();
  const integrity = aggregateIntegrity(database);
  const integrityMs = Number((performance.now() - integrityStarted).toFixed(3));

  const totalMs = Number((discoveryMs + catalogMs + ingestMs + exportMs).toFixed(3));
  console.log(JSON.stringify({
    source: "full-ingest",
    candidates: candidates.length,
    sourceBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
    rows: benchmarkStore.usageRecordCount(),
    discoveryMs,
    catalogMs,
    ingestMs,
    commitMs: Number(commitMs.toFixed(3)),
    commitCalls,
    transformAndParseMs: Number((ingestMs - commitMs).toFixed(3)),
    exportMs,
    totalMs,
    exportedBytes,
    result,
    integrity,
    integrityMs,
    warnings: new AnalyticsService(database, pricingEngine).warnings(),
  }, null, 2));
  database.close();
  if (!integrity.valid) {
    throw new Error("Full ingestion produced non-canonical aggregate totals");
  }
  if (options.maxMs !== undefined && totalMs > options.maxMs) {
    throw new Error(`Full ingestion took ${totalMs} ms, exceeding the ${options.maxMs} ms limit`);
  }
}
