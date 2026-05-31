/**
 * UsageStore — in-memory SQLite store (sql.js) with file-backed persistence.
 *
 * Wraps sql.js to provide typed access to usage records, tool events,
 * daily/session aggregates, and file cursors. The db lives in memory for fast
 * access; `flush()` exports it to disk.
 *
 * Key invariant: after `applyFileResult`, aggregates reflect the batch's
 * contribution. After `subtractFileContribution` + `deleteFileRows`, the file's
 * impact is fully removed.
 *
 * This module MUST NOT import `vscode`.
 */

import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type { FileCursor, FileContribution, StoreBatch } from "../../shared/storeTypes.js";
import { totalTokens } from "../../shared/types.js";
import { baseModelOf } from "../../shared/variant.js";
import { localDay } from "../../shared/time.js";

export class UsageStore {
  private db: Database | null = null;
  private dbPath: string = "";

  async open(dbPath: string, sqlJs?: initSqlJs.SqlJsStatic): Promise<void> {
    this.dbPath = dbPath;
    const SQL = sqlJs ?? await initSqlJs();

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

  async migrateOrRebuild(): Promise<"migrated" | "rebuilt" | "ok"> {
    const current = this.schemaVersion();
    if (current === SCHEMA_VERSION) {
      return "ok";
    }

    // v1: rebuild only, no migration logic
    const db = this.getDb();
    // Drop all existing tables
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'"
    );
    if (tables.length > 0) {
      for (const row of tables[0].values) {
        db.run(`DROP TABLE IF EXISTS "${row[0]}"`);
      }
    }

    // Recreate schema
    db.exec(SCHEMA_SQL);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    return "rebuilt";
  }

  flush(): void {
    const db = this.getDb();
    const data = db.export();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.dbPath, data);
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
      contribution: JSON.parse(row["contribution"] as string),
    };
  }

  putCursor(cursor: FileCursor): void {
    const db = this.getDb();
    db.run(
      `INSERT OR REPLACE INTO file_cursor
       (file_path, file_id, source, size, mtime_ms, last_byte_offset,
        head_hash, tail_anchor_hash, running_totals, recent_req_ids, contribution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );
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

  /** Record unmapped models into the unmapped_model table (replaces previous set). */
  recordUnmappedModels(models: string[]): void {
    const db = this.getDb();
    // Clear previous unmapped set and replace with current
    db.run("DELETE FROM unmapped_model");
    if (models.length === 0) { return; }
    const now = Date.now();
    for (const model of models) {
      db.run(
        `INSERT OR IGNORE INTO unmapped_model (model, first_seen_utc) VALUES (?, ?)`,
        [model, now],
      );
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
}
