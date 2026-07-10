/**
 * UsageStore — in-memory SQLite store (sql.js) with file-backed persistence.
 *
 * Wraps sql.js to provide typed access to usage records, tool events,
 * daily/session aggregates, and file cursors. The db lives in memory for fast
 * access; `flush()` exports it to disk.
 *
 * Production ingestion uses `commitFileResult`: usage rows, per-record costs,
 * affected aggregates, and the cursor commit in one transaction. Legacy
 * contribution methods remain for migration/property-test compatibility.
 *
 * This module MUST NOT import `vscode`.
 */

import initSqlJs, { Database } from "sql.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type { ModelRate, Source } from "../../shared/types.js";
import type { FileCursor, FileContribution, StoreBatch } from "../../shared/storeTypes.js";
import { totalTokens } from "../../shared/types.js";
import { baseModelOf } from "../../shared/variant.js";
import { localDay } from "../../shared/time.js";
import { parseRevisionForSource } from "../parsers/revision.js";
import { PricingEngine } from "../pricing.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_DISCOVERY_META_KEY = "last_full_discovery_utc";

interface FileCatalogCandidate {
  filePath: string;
  fileId: string;
  source: FileCursor["source"];
  size: number;
  mtimeMs: number;
}

export type FileCursorHeader = Pick<
  FileCursor,
  "filePath" | "fileId" | "source" | "size" | "mtimeMs" | "lastByteOffset" | "headHash" | "tailAnchorHash" | "parseRevision"
>;

export interface CursorRankInfo {
  cursor: FileCursorHeader;
  minDay?: string;
  maxDay?: string;
}

type CatalogIngestDecision = "skip" | "append" | "reingest" | "firstRead";

export class UsageStore {
  private db: Database | null = null;
  private dbPath: string = "";
  private sqlJs: initSqlJs.SqlJsStatic | null = null;

  async open(dbPath: string, sqlJs?: initSqlJs.SqlJsStatic): Promise<void> {
    this.dbPath = dbPath;
    const SQL = sqlJs ?? await initSqlJs();
    this.sqlJs = SQL;

    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
  }

  schemaVersion(): number {
    const db = this.getDb();
    try {
      const result = db.exec("SELECT value FROM meta WHERE key = 'schema_version'");
      if (result.length > 0 && result[0].values.length > 0) {
        return Number(result[0].values[0][0]);
      }
    } catch {
      // meta table doesn't exist yet
    }
    return 0;
  }

  async migrateOrRebuild(targetVersion = SCHEMA_VERSION): Promise<"migrated" | "rebuilt" | "ok"> {
    let current = this.schemaVersion();
    if (current === targetVersion) {
      this.ensureAuxiliarySchema();
      return "ok";
    }

    const db = this.getDb();
    if (targetVersion < 7 || targetVersion > SCHEMA_VERSION) {
      throw new Error(`Unsupported target database schema ${targetVersion}`);
    }
    if (current > targetVersion) {
      throw new Error(`Database schema ${current} is newer than supported schema ${targetVersion}`);
    }
    if (current === 6 && targetVersion >= 7) {
      this.migrateV6ToV7();
      current = 7;
    }
    if (current === 7 && targetVersion >= 8) {
      this.migrateV7ToV8();
      current = 8;
    }
    if (current === targetVersion) {
      this.ensureAuxiliarySchema();
      return "migrated";
    }
    if (current === 0 && !this.hasApplicationTables()) {
      if (targetVersion !== SCHEMA_VERSION) {
        throw new Error(`Cannot initialize an empty database at historical schema ${targetVersion}`);
      }
      db.exec(SCHEMA_SQL);
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
        String(SCHEMA_VERSION),
      ]);
      this.ensureAuxiliarySchema();
      return "rebuilt";
    }
    throw new Error(`Unsupported database schema ${current}; refusing to rebuild destructively`);
  }

  flush(): void {
    const db = this.getDb();
    const data = db.export();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.dbPath}.tmp`;
    const fd = openSync(tempPath, "w");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tempPath, this.dbPath);
    } catch (error) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  /** Restore the last atomically persisted snapshot after a failed force-full scan. */
  reload(): void {
    if (!this.sqlJs || !this.dbPath || !existsSync(this.dbPath)) {
      throw new Error("Cannot reload store before a persisted database has been opened");
    }
    this.db?.close();
    this.db = new this.sqlJs.Database(readFileSync(this.dbPath));
  }

  getCursor(filePath: string): FileCursor | undefined {
    const db = this.getDb();
    const stmt = db.prepare("SELECT * FROM file_cursor WHERE file_path = ?");
    stmt.bind([filePath]);
    if (!stmt.step()) {
      stmt.free();
      return undefined;
    }
    const row = stmt.getAsObject();
    stmt.free();

    return {
      filePath: row["file_path"] as string,
      fileId: row["file_id"] as string,
      source: row["source"] as FileCursor["source"],
      size: row["size"] as number,
      mtimeMs: row["mtime_ms"] as number,
      lastByteOffset: row["last_byte_offset"] as number,
      headHash: row["head_hash"] as string,
      tailAnchorHash: row["tail_anchor_hash"] as string,
      runningTotals: JSON.parse(row["running_totals"] as string),
      recentRequestIds: JSON.parse(row["recent_req_ids"] as string),
      parseRevision: Number(row["parse_revision"] ?? 0),
      contribution: JSON.parse(row["contribution"] as string),
    };
  }

  getCursorHeader(filePath: string): FileCursorHeader | undefined {
    const result = this.getDb().exec(
      `SELECT file_path, file_id, source, size, mtime_ms, last_byte_offset,
              head_hash, tail_anchor_hash, parse_revision
       FROM file_cursor WHERE file_path = ?`,
      [filePath],
    );
    const row = result[0]?.values[0];
    if (!row) { return undefined; }
    return {
      filePath: String(row[0]),
      fileId: String(row[1]),
      source: row[2] as FileCursor["source"],
      size: Number(row[3]),
      mtimeMs: Number(row[4]),
      lastByteOffset: Number(row[5]),
      headHash: String(row[6]),
      tailAnchorHash: String(row[7]),
      parseRevision: Number(row[8]),
    };
  }

  getCursorRankInfo(filePath: string): CursorRankInfo | undefined {
    const result = this.getDb().exec(
      `SELECT c.file_path, c.file_id, c.source, c.size, c.mtime_ms, c.last_byte_offset,
              c.head_hash, c.tail_anchor_hash, c.parse_revision, f.min_day, f.max_day
       FROM file_cursor c LEFT JOIN file_catalog f ON f.file_path = c.file_path
       WHERE c.file_path = ?`,
      [filePath],
    );
    const row = result[0]?.values[0];
    if (!row) { return undefined; }
    return {
      cursor: {
        filePath: String(row[0]), fileId: String(row[1]), source: row[2] as FileCursor["source"],
        size: Number(row[3]), mtimeMs: Number(row[4]), lastByteOffset: Number(row[5]),
        headHash: String(row[6]), tailAnchorHash: String(row[7]), parseRevision: Number(row[8]),
      },
      minDay: typeof row[9] === "string" ? row[9] : undefined,
      maxDay: typeof row[10] === "string" ? row[10] : undefined,
    };
  }

  putCursor(cursor: FileCursor): void {
    const db = this.getDb();
    db.run(
      `INSERT OR REPLACE INTO file_cursor
       (file_path, file_id, source, size, mtime_ms, last_byte_offset,
        head_hash, tail_anchor_hash, running_totals, recent_req_ids, contribution, parse_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cursor.filePath,
        cursor.fileId,
        cursor.source,
        cursor.size,
        cursor.mtimeMs,
        cursor.lastByteOffset,
        cursor.headHash,
        cursor.tailAnchorHash,
        JSON.stringify(cursor.runningTotals),
        JSON.stringify(cursor.recentRequestIds),
        JSON.stringify(cursor.contribution),
        cursor.parseRevision,
      ]
    );
  }

  recordDiscoveredFiles(candidates: FileCatalogCandidate[], now = Date.now()): void {
    if (candidates.length === 0) { return; }
    const db = this.getDb();
    db.run("BEGIN TRANSACTION");
    try {
      for (const c of candidates) {
        db.run(
          `INSERT INTO file_catalog
           (file_path, file_id, source, size, mtime_ms, first_seen_utc,
            last_seen_utc, last_changed_utc, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered')
           ON CONFLICT(file_path) DO UPDATE SET
             file_id = excluded.file_id,
             source = excluded.source,
             size = excluded.size,
             mtime_ms = excluded.mtime_ms,
             last_seen_utc = excluded.last_seen_utc,
             last_changed_utc = CASE
               WHEN file_catalog.file_id != excluded.file_id
                 OR file_catalog.size != excluded.size
                 OR file_catalog.mtime_ms != excluded.mtime_ms
               THEN excluded.last_changed_utc
               ELSE file_catalog.last_changed_utc
             END,
             state = CASE
               WHEN file_catalog.file_id != excluded.file_id
                 OR file_catalog.size != excluded.size
                 OR file_catalog.mtime_ms != excluded.mtime_ms
               THEN 'changed'
               ELSE file_catalog.state
             END`,
          [c.filePath, c.fileId, c.source, c.size, c.mtimeMs, now, now, now],
        );
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  recordFileCatalogPriorities(scores: Array<{ filePath: string; priorityScore: number }>): void {
    if (scores.length === 0) { return; }
    const db = this.getDb();
    db.run("BEGIN TRANSACTION");
    try {
      for (const score of scores) {
        db.run(
          "UPDATE file_catalog SET priority_score = ? WHERE file_path = ?",
          [score.priorityScore, score.filePath],
        );
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  recordFileCatalogIngestResult(
    candidate: FileCatalogCandidate,
    decision: CatalogIngestDecision,
    now = Date.now(),
  ): void {
    if (decision === "skip") {
      const hasCursor = this.getCursorHeader(candidate.filePath) !== undefined;
      this.getDb().run(
        "UPDATE file_catalog SET last_checked_utc = ?, state = ? WHERE file_path = ?",
        [now, hasCursor ? "complete" : "ignored", candidate.filePath],
      );
      return;
    }
    const cursor = this.getCursor(candidate.filePath);
    const range = cursor ? dayRangeFromContribution(cursor.contribution) : undefined;
    const state = cursor ? "complete" : "ignored";

    this.getDb().run(
      `UPDATE file_catalog SET
         last_checked_utc = ?,
         last_ingested_utc = CASE WHEN ? THEN ? ELSE last_ingested_utc END,
         min_day = ?,
         max_day = ?,
         state = ?
       WHERE file_path = ?`,
      [
        now,
        1,
        now,
        range?.minDay ?? null,
        range?.maxDay ?? null,
        state,
        candidate.filePath,
      ],
    );
  }

  clearIngestedData(): void {
    const db = this.getDb();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("DELETE FROM tool_event");
      db.run("DELETE FROM usage_record");
      db.run("DELETE FROM daily_aggregate");
      db.run("DELETE FROM session_aggregate");
      db.run("DELETE FROM file_cursor");
      db.run("DELETE FROM file_catalog");
      db.run("DELETE FROM unmapped_model");
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  resetDatabase(): void {
    const db = this.getDb();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("DELETE FROM tool_event");
      db.run("DELETE FROM usage_record");
      db.run("DELETE FROM daily_aggregate");
      db.run("DELETE FROM session_aggregate");
      db.run("DELETE FROM file_cursor");
      db.run("DELETE FROM file_catalog");
      db.run("DELETE FROM pricing");
      db.run("DELETE FROM unmapped_model");
      db.run("DELETE FROM meta WHERE key != 'schema_version'");
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  hotCatalogFilePaths(now = Date.now(), limit = 200): string[] {
    const recentCutoff = now - DAY_MS;
    const weekStart = localDay(new Date(now - 6 * DAY_MS));
    const db = this.getDb();
    const result = db.exec(
      `SELECT file_path
       FROM file_catalog
       WHERE state != 'ignored'
         AND (
           last_changed_utc >= ?
           OR mtime_ms >= ?
           OR max_day >= ?
         )
       ORDER BY priority_score DESC, last_changed_utc DESC, mtime_ms DESC
       LIMIT ?`,
      [recentCutoff, recentCutoff, weekStart, limit],
    );
    if (result.length === 0) { return []; }
    return result[0].values
      .map((row) => row[0])
      .filter((value): value is string => typeof value === "string");
  }

  shouldRunFullDiscovery(now = Date.now(), minIntervalMs: number): boolean {
    const lastRun = this.getMetaNumber(FULL_DISCOVERY_META_KEY);
    return lastRun === undefined || now - lastRun >= minIntervalMs;
  }

  markFullDiscoveryRun(now = Date.now()): void {
    this.setMeta(FULL_DISCOVERY_META_KEY, String(now));
  }

  applyFileResult(fileId: string, batch: StoreBatch): void {
    const db = this.getDb();
    db.run("BEGIN TRANSACTION");
    try {
      // Upsert usage records
      for (const rec of batch.records) {
        const total = totalTokens(rec);
        const tsDate = new Date(rec.timestamp);
        const dayLocal = localDay(tsDate);
        const dowLocal = tsDate.getDay();
        const hourLocal = tsDate.getHours();

        db.run(
          `INSERT OR REPLACE INTO usage_record
           (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
            model, effort, variant_id, workspace,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            reasoning_tokens, total_tokens, context_window, context_used_tokens,
            is_sidechain, stop_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            rec.dedupKey,
            fileId,
            rec.source,
            rec.sessionId,
            rec.timestamp,
            dayLocal,
            dowLocal,
            hourLocal,
            rec.model,
            rec.effort ?? "n/a",
            rec.variantId,
            rec.workspace ?? "",
            rec.inputTokens,
            rec.outputTokens,
            rec.cacheReadTokens,
            rec.cacheCreationTokens,
            rec.reasoningTokens,
            total,
            rec.meta?.contextWindow ?? null,
            rec.meta?.contextUsedTokens ?? null,
            rec.meta?.isSidechain ? 1 : 0,
            rec.meta?.stopReason ?? null,
          ]
        );

        // Delete existing tool_event rows for this record's dedupKey
        db.run("DELETE FROM tool_event WHERE record_dedup_key = ?", [rec.dedupKey]);
      }

      // Insert tool events
      for (const evt of batch.toolEvents) {
        const tsDate = new Date(evt.timestamp);
        const dayLocal = localDay(tsDate);

        db.run(
          `INSERT OR REPLACE INTO tool_event
           (event_key, record_dedup_key, file_id, source, session_id, ts_utc,
            day_local, tool_name, model, variant_id, workspace, is_sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            evt.eventKey,
            evt.recordDedupKey,
            fileId,
            evt.source,
            evt.sessionId,
            evt.timestamp,
            dayLocal,
            evt.toolName,
            "", // model resolved via join if needed
            "", // variant_id resolved via join if needed
            "", // workspace resolved via join if needed
            evt.isSidechain ? 1 : 0,
          ]
        );
      }

      // Upsert daily aggregates
      for (const d of batch.contribution.daily) {
        const bm = baseModelOf(d.variantId);
        const totalTok =
          d.sums.inputTokens + d.sums.outputTokens + d.sums.cacheReadTokens +
          d.sums.cacheCreationTokens + d.sums.reasoningTokens;

        db.run(
          `INSERT INTO daily_aggregate
           (day_local, source, variant_id, base_model, workspace,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            reasoning_tokens, total_tokens, turns, cost_usd, unknown_cost_turns)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day_local, source, variant_id, workspace)
           DO UPDATE SET
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
             reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
             total_tokens = total_tokens + excluded.total_tokens,
             turns = turns + excluded.turns,
             cost_usd = cost_usd + excluded.cost_usd,
             unknown_cost_turns = unknown_cost_turns + excluded.unknown_cost_turns`,
          [
            d.day,
            d.source,
            d.variantId,
            bm,
            d.workspace,
            d.sums.inputTokens,
            d.sums.outputTokens,
            d.sums.cacheReadTokens,
            d.sums.cacheCreationTokens,
            d.sums.reasoningTokens,
            totalTok,
            d.turns,
            d.costUsd,
            d.unknownTurns,
          ]
        );
      }

      // Upsert session aggregates
      for (const s of batch.contribution.sessions) {
        const totalTok =
          s.sums.inputTokens + s.sums.outputTokens + s.sums.cacheReadTokens +
          s.sums.cacheCreationTokens + s.sums.reasoningTokens;

        // Derive workspace from records in this session
        const sessionWorkspace = batch.records.find(
          (r) => r.source === s.source && r.sessionId === s.sessionId && r.workspace
        )?.workspace ?? "";

        db.run(
          `INSERT INTO session_aggregate
           (source, session_id, workspace, first_ts_utc, last_ts_utc,
            turns, total_tokens, cost_usd, sidechain_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, session_id)
           DO UPDATE SET
             workspace = CASE WHEN excluded.workspace != '' THEN excluded.workspace ELSE workspace END,
             first_ts_utc = MIN(first_ts_utc, excluded.first_ts_utc),
             last_ts_utc = MAX(last_ts_utc, excluded.last_ts_utc),
             turns = turns + excluded.turns,
             total_tokens = total_tokens + excluded.total_tokens,
             cost_usd = cost_usd + excluded.cost_usd,
             sidechain_tokens = sidechain_tokens + excluded.sidechain_tokens`,
          [
            s.source,
            s.sessionId,
            sessionWorkspace,
            s.firstTsUtc,
            s.lastTsUtc,
            s.turns,
            totalTok,
            s.costUsd,
            s.sidechainTokens,
          ]
        );
      }

      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  /**
   * Canonical targeted commit used by schema v8 ingestion. Aggregate rows are
   * recomputed from usage_record for every affected key, so cursor contribution
   * costs are never used as an accounting source.
   */
  commitFileResult(
    fileId: string,
    batch: StoreBatch,
    decision: CatalogIngestDecision,
    pricing: PricingEngine,
    cursor: FileCursor,
    previousFileId = fileId,
  ): void {
    const db = this.getDb();
    const dailyKeys = new Set<string>();
    const sessionKeys = new Set<string>();
    const sessionModelKeys = new Set<string>();

    const rememberRow = (row: Array<string | number | Uint8Array | null>): void => {
      const day = String(row[0]);
      const source = String(row[1]);
      const sessionId = String(row[2]);
      const model = String(row[3]);
      const variantId = String(row[4]);
      const workspace = String(row[5]);
      dailyKeys.add(encodeKey(day, source, variantId, workspace));
      sessionKeys.add(encodeKey(source, sessionId));
      sessionModelKeys.add(encodeKey(source, sessionId, model));
    };

    db.run("BEGIN TRANSACTION");
    try {
      if (decision === "reingest") {
        const oldRows = db.exec(
          `SELECT day_local, source, session_id, model, variant_id, workspace
           FROM usage_record WHERE file_id = ?`,
          [previousFileId],
        );
        for (const row of oldRows[0]?.values ?? []) { rememberRow(row); }
        db.run("DELETE FROM tool_event WHERE file_id = ?", [previousFileId]);
        db.run("DELETE FROM usage_record WHERE file_id = ?", [previousFileId]);
      }

      for (const rec of batch.records) {
        const tsDate = new Date(rec.timestamp);
        const day = localDay(tsDate);
        dailyKeys.add(encodeKey(day, rec.source, rec.variantId, rec.workspace ?? ""));
        sessionKeys.add(encodeKey(rec.source, rec.sessionId));
        sessionModelKeys.add(encodeKey(rec.source, rec.sessionId, rec.model));
        db.run(
          `INSERT OR REPLACE INTO usage_record
           (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
            model, effort, variant_id, workspace, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
            context_window, context_used_tokens, is_sidechain, stop_reason, cost_usd, cost_unknown)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
          [
            rec.dedupKey, fileId, rec.source, rec.sessionId, rec.timestamp, day,
            tsDate.getDay(), tsDate.getHours(), rec.model, rec.effort ?? "n/a",
            rec.variantId, rec.workspace ?? "", rec.inputTokens, rec.outputTokens,
            rec.cacheReadTokens, rec.cacheCreationTokens, rec.reasoningTokens,
            totalTokens(rec), rec.meta?.contextWindow ?? null,
            rec.meta?.contextUsedTokens ?? null, rec.meta?.isSidechain ? 1 : 0,
            rec.meta?.stopReason ?? null,
          ],
        );
        db.run("DELETE FROM tool_event WHERE record_dedup_key = ?", [rec.dedupKey]);
      }

      for (const evt of batch.toolEvents) {
        db.run(
          `INSERT OR REPLACE INTO tool_event
           (event_key, record_dedup_key, file_id, source, session_id, ts_utc,
            day_local, tool_name, model, variant_id, workspace, is_sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?)`,
          [
            evt.eventKey, evt.recordDedupKey, fileId, evt.source, evt.sessionId,
            evt.timestamp, localDay(new Date(evt.timestamp)), evt.toolName,
            evt.isSidechain ? 1 : 0,
          ],
        );
      }

      for (const encoded of sessionModelKeys) {
        const [source, sessionId, model] = decodeKey(encoded);
        const rows = db.exec(
          `SELECT dedup_key, day_local, variant_id, workspace,
                  input_tokens, output_tokens, cache_read_tokens,
                  cache_creation_tokens, reasoning_tokens, context_used_tokens
           FROM usage_record WHERE source = ? AND session_id = ? AND model = ?`,
          [source, sessionId, model],
        );
        const values = rows[0]?.values ?? [];
        let maxContext: number | undefined;
        for (const row of values) {
          if (typeof row[9] === "number") {
            maxContext = Math.max(maxContext ?? 0, row[9]);
          }
          dailyKeys.add(encodeKey(String(row[1]), source, String(row[2]), String(row[3])));
        }
        const forceLongContext = pricing.longContextStatus(model, maxContext).applied;
        for (const row of values) {
          const cost = pricing.costOfAggregate(model, {
            inputTokens: Number(row[4]),
            outputTokens: Number(row[5]),
            cacheReadTokens: Number(row[6]),
            cacheCreationTokens: Number(row[7]),
            reasoningTokens: Number(row[8]),
          }, { forceLongContext });
          db.run(
            "UPDATE usage_record SET cost_usd = ?, cost_unknown = ? WHERE dedup_key = ?",
            [cost.usd, cost.unknown ? 1 : 0, String(row[0])],
          );
        }
      }

      for (const encoded of dailyKeys) {
        const [day, source, variantId, workspace] = decodeKey(encoded);
        db.run(
          "DELETE FROM daily_aggregate WHERE day_local = ? AND source = ? AND variant_id = ? AND workspace = ?",
          [day, source, variantId, workspace],
        );
        db.run(
          `INSERT INTO daily_aggregate
           (day_local, source, variant_id, base_model, workspace,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            reasoning_tokens, total_tokens, turns, cost_usd, unknown_cost_turns)
           SELECT day_local, source, variant_id, MAX(model), workspace,
                  SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                  SUM(cache_creation_tokens), SUM(reasoning_tokens), SUM(total_tokens),
                  COUNT(*), SUM(cost_usd), SUM(cost_unknown)
           FROM usage_record
           WHERE day_local = ? AND source = ? AND variant_id = ? AND workspace = ?
           GROUP BY day_local, source, variant_id, workspace`,
          [day, source, variantId, workspace],
        );
      }

      for (const encoded of sessionKeys) {
        const [source, sessionId] = decodeKey(encoded);
        db.run("DELETE FROM session_aggregate WHERE source = ? AND session_id = ?", [source, sessionId]);
        db.run(
          `INSERT INTO session_aggregate
           (source, session_id, workspace, first_ts_utc, last_ts_utc,
            turns, total_tokens, cost_usd, sidechain_tokens)
           SELECT source, session_id,
                  MAX(CASE WHEN workspace != '' THEN workspace ELSE '' END),
                  MIN(ts_utc), MAX(ts_utc), COUNT(*), SUM(total_tokens), SUM(cost_usd),
                  SUM(CASE WHEN is_sidechain = 1 THEN total_tokens ELSE 0 END)
           FROM usage_record WHERE source = ? AND session_id = ?
           GROUP BY source, session_id`,
          [source, sessionId],
        );
      }

      this.putCursor(cursor);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  }

  subtractFileContribution(fileId: string): void {
    const db = this.getDb();

    // Find the cursor for this fileId
    const stmt = db.prepare("SELECT contribution FROM file_cursor WHERE file_id = ?");
    stmt.bind([fileId]);
    if (!stmt.step()) {
      stmt.free();
      return; // no cursor, nothing to subtract
    }
    const row = stmt.getAsObject();
    stmt.free();

    const contribution: FileContribution = JSON.parse(row["contribution"] as string);

    // Subtract daily deltas
    for (const d of contribution.daily) {
      const totalTok =
        d.sums.inputTokens + d.sums.outputTokens + d.sums.cacheReadTokens +
        d.sums.cacheCreationTokens + d.sums.reasoningTokens;

      db.run(
        `UPDATE daily_aggregate SET
           input_tokens = input_tokens - ?,
           output_tokens = output_tokens - ?,
           cache_read_tokens = cache_read_tokens - ?,
           cache_creation_tokens = cache_creation_tokens - ?,
           reasoning_tokens = reasoning_tokens - ?,
           total_tokens = total_tokens - ?,
           turns = turns - ?,
           cost_usd = cost_usd - ?,
           unknown_cost_turns = unknown_cost_turns - ?
         WHERE day_local = ? AND source = ? AND variant_id = ? AND workspace = ?`,
        [
          d.sums.inputTokens,
          d.sums.outputTokens,
          d.sums.cacheReadTokens,
          d.sums.cacheCreationTokens,
          d.sums.reasoningTokens,
          totalTok,
          d.turns,
          d.costUsd,
          d.unknownTurns,
          d.day,
          d.source,
          d.variantId,
          d.workspace,
        ]
      );
    }

    // Clean up zeroed daily rows
    db.run("DELETE FROM daily_aggregate WHERE turns <= 0");

    // Subtract session deltas
    for (const s of contribution.sessions) {
      const totalTok =
        s.sums.inputTokens + s.sums.outputTokens + s.sums.cacheReadTokens +
        s.sums.cacheCreationTokens + s.sums.reasoningTokens;

      db.run(
        `UPDATE session_aggregate SET
           turns = turns - ?,
           total_tokens = total_tokens - ?,
           cost_usd = cost_usd - ?,
           sidechain_tokens = sidechain_tokens - ?
         WHERE source = ? AND session_id = ?`,
        [
          s.turns,
          totalTok,
          s.costUsd,
          s.sidechainTokens,
          s.source,
          s.sessionId,
        ]
      );
    }

    // Clean up zeroed session rows
    db.run("DELETE FROM session_aggregate WHERE turns <= 0");
  }

  deleteCursor(filePath: string): void {
    const db = this.getDb();
    db.run("DELETE FROM file_cursor WHERE file_path = ?", [filePath]);
  }

  deleteFileRows(fileId: string): void {
    const db = this.getDb();
    db.run("DELETE FROM tool_event WHERE file_id = ?", [fileId]);
    db.run("DELETE FROM usage_record WHERE file_id = ?", [fileId]);
  }

  /**
   * Increment malformed_line_count and oversized_line_count in the meta table.
   * Incremental appends only parse new bytes, so each run adds only newly-seen
   * issues. forceFull rescans call `resetQualityCounters()` first.
   */
  updateMetaCounts(malformed: number, oversized: number): void {
    const db = this.getDb();
    if (malformed > 0) {
      db.run(
        `INSERT INTO meta (key, value) VALUES ('malformed_line_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
        [String(malformed), malformed],
      );
    }
    if (oversized > 0) {
      db.run(
        `INSERT INTO meta (key, value) VALUES ('oversized_line_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
        [String(oversized), oversized],
      );
    }
  }

  /** Reset the quality counters to 0 (called before a forceFull rescan). */
  resetQualityCounters(): void {
    const db = this.getDb();
    db.run("DELETE FROM meta WHERE key IN ('malformed_line_count', 'oversized_line_count')");
  }

  /** Return the set of distinct model names currently in the store. */
  distinctModels(): Set<string> {
    const db = this.getDb();
    const result = db.exec("SELECT DISTINCT model FROM usage_record");
    const models = new Set<string>();
    if (result.length > 0) {
      for (const row of result[0].values) {
        if (typeof row[0] === "string") { models.add(row[0]); }
      }
    }
    return models;
  }

  /** Set a meta key to a string value. */
  setMeta(key: string, value: string): void {
    const db = this.getDb();
    db.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      [key, value],
    );
  }

  getMeta(key: string): string | undefined {
    const result = this.getDb().exec("SELECT value FROM meta WHERE key = ?", [key]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    const value = result[0].values[0][0];
    return typeof value === "string" ? value : undefined;
  }

  usageRecordCount(): number {
    const result = this.getDb().exec("SELECT COUNT(*) FROM usage_record");
    if (result.length === 0 || result[0].values.length === 0) {
      return 0;
    }
    return Number(result[0].values[0][0]);
  }

  usageRecordCountForSource(source: Source): number {
    const result = this.getDb().exec(
      "SELECT COUNT(*) FROM usage_record WHERE source = ?",
      [source],
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return 0;
    }
    return Number(result[0].values[0][0]);
  }

  usageRecordSources(): Set<Source> {
    const result = this.getDb().exec("SELECT DISTINCT source FROM usage_record");
    const sources = new Set<Source>();
    if (result.length === 0) {
      return sources;
    }
    for (const row of result[0].values) {
      const value = row[0];
      if (value === "codex" || value === "claude") {
        sources.add(value);
      }
    }
    return sources;
  }

  storedFileIdentities(): Array<{ source: Source; filePath: string; fileId: string }> {
    const result = this.getDb().exec(
      `SELECT DISTINCT c.source, c.file_path, c.file_id
       FROM file_cursor c
       WHERE EXISTS (
         SELECT 1
         FROM usage_record r
         WHERE r.file_id = c.file_id
           AND r.source = c.source
       )`,
    );
    const files: Array<{ source: Source; filePath: string; fileId: string }> = [];
    if (result.length === 0) {
      return files;
    }
    for (const row of result[0].values) {
      const source = row[0];
      const filePath = row[1];
      const fileId = row[2];
      if (
        (source === "codex" || source === "claude") &&
        typeof filePath === "string" &&
        typeof fileId === "string"
      ) {
        files.push({ source, filePath, fileId });
      }
    }
    return files;
  }

  /**
   * Record currently unmapped models and auto-register them with fallback rates.
   *
   * `unmapped_model` remains the warning surface: it tracks models whose pricing
   * is not in the bundled/user table. `pricing` is a local registry so newly
   * observed models are not invisible to the database while users decide whether
   * to add explicit rates.
   */
  recordUnmappedModels(models: string[], fallbackRate?: ModelRate): void {
    const db = this.getDb();
    const now = Date.now();
    const uniqueModels = [...new Set(models)].sort();
    db.run("BEGIN TRANSACTION");
    try {
      if (uniqueModels.length === 0) {
        db.run("DELETE FROM unmapped_model");
      } else {
        const placeholders = uniqueModels.map(() => "?").join(",");
        db.run(`DELETE FROM unmapped_model WHERE model NOT IN (${placeholders})`, uniqueModels);
        for (const model of uniqueModels) {
          db.run(
            `INSERT OR IGNORE INTO unmapped_model (model, first_seen_utc) VALUES (?, ?)`,
            [model, now],
          );
          if (fallbackRate) {
            db.run(
              `INSERT OR IGNORE INTO pricing (model, rates_json) VALUES (?, ?)`,
              [model, JSON.stringify(fallbackRate)],
            );
          }
        }
      }
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  /** Expose the underlying Database for AnalyticsService queries. */
  get database(): Database {
    return this.getDb();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error("UsageStore not opened. Call open() first.");
    }
    return this.db;
  }

  private ensureAuxiliarySchema(): void {
    this.getDb().exec(`
      CREATE TABLE IF NOT EXISTS file_catalog (
        file_path         TEXT PRIMARY KEY,
        file_id           TEXT NOT NULL,
        source            TEXT NOT NULL,
        size              INTEGER NOT NULL,
        mtime_ms          INTEGER NOT NULL,
        first_seen_utc    INTEGER NOT NULL,
        last_seen_utc     INTEGER NOT NULL,
        last_changed_utc  INTEGER NOT NULL,
        last_checked_utc  INTEGER,
        last_ingested_utc INTEGER,
        min_day           TEXT,
        max_day           TEXT,
        state             TEXT NOT NULL,
        priority_score    REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_file_catalog_hot
        ON file_catalog(source, state, priority_score, last_changed_utc, mtime_ms);
      CREATE INDEX IF NOT EXISTS idx_file_catalog_days
        ON file_catalog(max_day, min_day);
    `);
  }

  private hasApplicationTables(): boolean {
    const result = this.getDb().exec(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('usage_record', 'file_cursor', 'daily_aggregate')",
    );
    return Number(result[0]?.values[0]?.[0] ?? 0) > 0;
  }

  private migrateV6ToV7(): void {
    const db = this.getDb();
    const before = this.migrationFingerprint();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("ALTER TABLE file_cursor ADD COLUMN parse_revision INTEGER NOT NULL DEFAULT 0");
      const rows = db.exec("SELECT file_path, source, contribution FROM file_cursor");
      if (rows.length > 0) {
        const update = db.prepare("UPDATE file_cursor SET parse_revision = ? WHERE file_path = ?");
        try {
          for (const row of rows[0].values) {
            const filePath = row[0];
            const source = row[1];
            const serialized = row[2];
            if (
              typeof filePath !== "string" ||
              (source !== "codex" && source !== "claude") ||
              typeof serialized !== "string"
            ) {
              continue;
            }
            try {
              const contribution = JSON.parse(serialized) as FileContribution;
              if (!isEmptyContribution(contribution)) {
                update.run([parseRevisionForSource(source), filePath]);
              }
            } catch {
              // Leave malformed legacy cursors at revision 0 so they are safely reparsed.
            }
          }
        } finally {
          update.free();
        }
      }
      db.run("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
    const after = this.migrationFingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Schema v7 migration changed canonical usage data");
    }
  }

  private migrationFingerprint(): number[] {
    const result = this.getDb().exec(
      `SELECT COUNT(*), COUNT(DISTINCT dedup_key),
              COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
              COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_creation_tokens), 0),
              COALESCE(SUM(reasoning_tokens), 0)
       FROM usage_record`,
    );
    return (result[0]?.values[0] ?? []).map(Number);
  }

  private migrateV7ToV8(): void {
    const db = this.getDb();
    const before = this.migrationFingerprint();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("ALTER TABLE usage_record ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
      db.run("ALTER TABLE usage_record ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0");
      db.run("CREATE INDEX IF NOT EXISTS idx_rec_session_model ON usage_record(source, session_id, model)");
      db.run("CREATE INDEX IF NOT EXISTS idx_rec_daily_key ON usage_record(day_local, source, variant_id, workspace)");
      db.run("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
    const after = this.migrationFingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Schema v8 migration changed canonical usage data");
    }
  }

  private getMetaNumber(key: string): number | undefined {
    const result = this.getDb().exec("SELECT value FROM meta WHERE key = ?", [key]);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    const value = Number(result[0].values[0][0]);
    return Number.isFinite(value) ? value : undefined;
  }
}

function dayRangeFromContribution(contribution: FileContribution): { minDay: string; maxDay: string } | undefined {
  let minDay: string | undefined;
  let maxDay: string | undefined;

  for (const daily of contribution.daily) {
    if (!minDay || daily.day < minDay) {
      minDay = daily.day;
    }
    if (!maxDay || daily.day > maxDay) {
      maxDay = daily.day;
    }
  }

  if (minDay && maxDay) {
    return { minDay, maxDay };
  }
  return undefined;
}

function isEmptyContribution(contribution: FileContribution): boolean {
  return contribution.daily.length === 0 &&
    contribution.sessions.length === 0 &&
    contribution.recordKeys.length === 0 &&
    contribution.toolEventCount === 0;
}

function encodeKey(...parts: string[]): string {
  return parts.join("\0");
}

function decodeKey(value: string): string[] {
  return value.split("\0");
}
