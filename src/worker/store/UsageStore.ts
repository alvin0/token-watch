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

import initSqlJs, { Database, Statement } from "sql.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { MAX_READABLE_SCHEMA, PRUNED_SCHEMA_VERSION, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { storageKey } from "./dedupKey.js";
import type { ModelRate, Source } from "../../shared/types.js";
import type { FileCursor, FileContribution, StoreBatch } from "../../shared/storeTypes.js";
import { totalTokens } from "../../shared/types.js";
import { baseModelOf } from "../../shared/variant.js";
import { localDay, localDayFromMs, parseLocalDay } from "../../shared/time.js";
import { LEGACY_V6_PARSE_REVISION } from "../parsers/revision.js";
import { PricingEngine } from "../pricing.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_DISCOVERY_META_KEY = "last_full_discovery_utc";
const WRITE_LOCK_STALE_MS = 5 * 60 * 1000;
const SNAPSHOT_READ_ATTEMPTS = 3;

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

/**
 * Aggregate rows a commit has invalidated but may not have rebuilt yet.
 *
 * Carried between the batch commits of one file so the rebuild happens once,
 * at the end, rather than once per batch over an ever-growing session.
 */
export interface DerivedKeys {
  daily: Set<string>;
  session: Set<string>;
  sessionModel: Set<string>;
}

/**
 * The write fence rejected this worker: it no longer holds the writer lease.
 *
 * Distinct from a concurrent-write collision because the response differs — a
 * collision means "someone wrote while you weren't looking, reload"; a lost
 * fence means "you are not the writer any more, stop writing".
 */
export class WriterFenceLostError extends Error {
  constructor() {
    super("Lost the usage database writer lease; another VS Code window owns it now");
    this.name = "WriterFenceLostError";
  }
}

export function isWriterFenceLostError(error: unknown): error is WriterFenceLostError {
  return error instanceof WriterFenceLostError;
}

export class ConcurrentUsageStoreWriteError extends Error {
  constructor() {
    super("Usage database changed in another VS Code window; refusing to overwrite it");
    this.name = "ConcurrentUsageStoreWriteError";
  }
}

export function isConcurrentUsageStoreWriteError(error: unknown): error is ConcurrentUsageStoreWriteError {
  return error instanceof ConcurrentUsageStoreWriteError;
}

/**
 * How long a temp snapshot must sit untouched before it is assumed abandoned.
 *
 * Writing one is a single fsync of the whole database — slow, but nowhere near
 * an hour even for a very large file — so nothing this old can still belong to
 * a live writer in another window.
 */
const ABANDONED_SNAPSHOT_AGE_MS = 60 * 60 * 1000;

/**
 * Delete temp snapshots that earlier runs could not clean up.
 *
 * The write is atomic by temp-file-and-rename, and a process killed between the
 * two — a window closed mid-flush, a crash — leaves the temp behind. Each one is
 * a full copy of the database, so on a large install they quietly accumulated
 * into gigabytes that nothing would ever reclaim.
 */
function sweepAbandonedSnapshots(dbPath: string, now = Date.now()): number {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.`;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) { continue; }
    const full = join(dir, entry);
    try {
      if (now - statSync(full).mtimeMs < ABANDONED_SNAPSHOT_AGE_MS) { continue; }
      unlinkSync(full);
      removed++;
    } catch { /* another window may be sweeping the same directory */ }
  }
  return removed;
}

/** Meta key holding the first local day that still has raw rows. */
const RETAINED_FROM_DAY_KEY = "raw_retained_from_day";
const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

/** What a retention pass removed. */
export interface PruneOutcome {
  prunedRecords: number;
  prunedToolEvents: number;
  /** The watermark now in force, or undefined if nothing is pruned. */
  retainedFromDay: string | undefined;
}

export class UsageStore {
  private db: Database | null = null;
  private dbPath: string = "";
  private sqlJs: initSqlJs.SqlJsStatic | null = null;
  private persistedFileIdentity: string | undefined;
  /** `total_changes()` at the last successful flush; undefined = never flushed. */
  private lastFlushedChangeCount: number | undefined;
  private lastFlushAtMs = 0;
  /** Set for DDL and other writes SQLite does not count in `total_changes()`. */
  private structurallyDirty = false;
  /**
   * Checked while the write lock is held, immediately before the snapshot is
   * renamed into place.
   *
   * Deciding "am I the writer?" before starting a scan is not a fence: the
   * lease can be taken over during the minutes that scan runs. This is the
   * check that actually gates the write.
   */
  private writeFence: (() => boolean) | undefined;

  async open(dbPath: string, sqlJs?: initSqlJs.SqlJsStatic): Promise<void> {
    this.dbPath = dbPath;
    const SQL = sqlJs ?? await initSqlJs();
    this.sqlJs = SQL;
    sweepAbandonedSnapshots(dbPath);

    if (existsSync(dbPath)) {
      const snapshot = readStableSnapshot(dbPath);
      this.db = new SQL.Database(snapshot.buffer);
      this.persistedFileIdentity = snapshot.identity;
      this.lastFlushedChangeCount = this.changeCount();
      this.structurallyDirty = false;
    } else {
      this.db = new SQL.Database();
      this.persistedFileIdentity = undefined;
      // Nothing on disk yet, so the first flush must write regardless.
      this.lastFlushedChangeCount = undefined;
      this.structurallyDirty = true;
    }
    this.lastFlushAtMs = 0;
  }

  /**
   * Row changes SQLite has applied on this connection. Cheap to read, and the
   * signal that decides whether a flush would rewrite an identical file.
   */
  private changeCount(): number {
    const result = this.getDb().exec("SELECT total_changes()");
    return Number(result[0]?.values?.[0]?.[0] ?? 0);
  }

  /** True when the in-memory database differs from the persisted snapshot. */
  isDirty(): boolean {
    if (this.structurallyDirty || this.lastFlushedChangeCount === undefined) {
      return true;
    }
    return this.changeCount() !== this.lastFlushedChangeCount;
  }

  /** Mark writes SQLite does not count — schema DDL, migrations, truncations. */
  markStructurallyDirty(): void {
    this.structurallyDirty = true;
  }

  /**
   * Install the ownership check consulted at the moment of writing.
   *
   * Passing `undefined` removes it, for single-writer contexts such as tests
   * and migrations that own the file outright.
   */
  setWriteFence(fence: (() => boolean) | undefined): void {
    this.writeFence = fence;
  }

  /**
   * Flush only if enough time has passed since the last one.
   *
   * Watch ticks rewrite bookkeeping (last-seen stamps, catalog priorities) even
   * when no usage row moved. Exporting and rewriting the whole database for
   * that, every few seconds, is the write amplification this bounds; losing a
   * few minutes of bookkeeping on a crash costs nothing but a rescan.
   */
  flushIfDue(intervalMs: number, now = Date.now()): boolean {
    if (now - this.lastFlushAtMs < intervalMs) {
      return false;
    }
    return this.flush();
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
      // A pruned database carries a higher number so older builds stay out of
      // it; this build is the one that put it there and knows how to read it.
      if (targetVersion === SCHEMA_VERSION && current <= MAX_READABLE_SCHEMA) {
        this.ensureAuxiliarySchema();
        return "ok";
      }
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
    if (current === 8 && targetVersion >= 9) {
      this.migrateV8ToV9();
      current = 9;
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

  /**
   * Persist the in-memory database. Returns whether a write actually happened:
   * an unchanged database is not re-exported, because `db.export()` plus a full
   * rewrite is the single most expensive thing this store does.
   */
  flush(options: { force?: boolean } = {}): boolean {
    const db = this.getDb();
    if (!options.force && !this.isDirty()) {
      return false;
    }
    const data = db.export();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const lockPath = `${this.dbPath}.lock`;
    const lock = acquireWriteLock(lockPath);
    try {
      // Inside the lock, so the answer cannot go stale between the check and
      // the rename below.
      if (this.writeFence && !this.writeFence()) {
        throw new WriterFenceLostError();
      }
      const currentFileIdentity = existsSync(this.dbPath)
        ? fileIdentity(this.dbPath)
        : undefined;
      if (currentFileIdentity !== this.persistedFileIdentity) {
        throw new ConcurrentUsageStoreWriteError();
      }
      const tempPath = `${this.dbPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const fd = openSync(tempPath, "w");
        try {
          writeFileSync(fd, data);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tempPath, this.dbPath);
        this.persistedFileIdentity = fileIdentity(this.dbPath);
      } catch (error) {
        // Every failure path, not just a failed rename: a write or fsync that
        // threw used to leave a full-size snapshot on disk permanently.
        try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
        throw error;
      }
    } finally {
      closeSync(lock.fd);
      try {
        if (readFileSync(lockPath, "utf8") === lock.owner) {
          unlinkSync(lockPath);
        }
      } catch { /* best-effort cleanup */ }
    }
    this.lastFlushedChangeCount = this.changeCount();
    this.structurallyDirty = false;
    this.lastFlushAtMs = Date.now();
    return true;
  }

  /**
   * Reload only when another window has replaced the file on disk.
   *
   * A follower worker (one that does not hold the writer lease) uses this to
   * pick up the owner's writes without ingesting anything itself. Returns
   * whether a reload happened.
   */
  reloadIfChangedOnDisk(): boolean {
    if (!this.sqlJs || !this.dbPath || !existsSync(this.dbPath)) {
      return false;
    }
    if (fileIdentity(this.dbPath) === this.persistedFileIdentity) {
      return false;
    }
    this.reload();
    return true;
  }

  /** Restore the last atomically persisted snapshot after a failed force-full scan. */
  reload(): void {
    if (!this.sqlJs || !this.dbPath || !existsSync(this.dbPath)) {
      throw new Error("Cannot reload store before a persisted database has been opened");
    }
    const snapshot = readStableSnapshot(this.dbPath);
    this.db?.close();
    this.db = new this.sqlJs.Database(snapshot.buffer);
    this.persistedFileIdentity = snapshot.identity;
    this.lastFlushedChangeCount = this.changeCount();
    this.structurallyDirty = false;
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
    // Bare DELETEs can take SQLite's truncate path, which does not count rows.
    this.markStructurallyDirty();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("DELETE FROM tool_event");
      db.run("DELETE FROM usage_record");
      db.run("DELETE FROM daily_aggregate");
      db.run("DELETE FROM session_aggregate");
      db.run("DELETE FROM file_cursor");
      db.run("DELETE FROM file_catalog");
      db.run("DELETE FROM unmapped_model");
      // Every day is about to be re-read from the logs, so none is pruned any
      // more. Leaving the watermark would make the next rebuild preserve stale
      // aggregates for days it is about to recompute properly.
      db.run("DELETE FROM meta WHERE key = 'raw_retained_from_day'");
      // No aggregate outlives its rows any more, so the reason older builds
      // were locked out is gone with them. A reset restores compatibility.
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  resetDatabase(): void {
    const db = this.getDb();
    this.markStructurallyDirty();
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
      // Nothing is pruned any more, so the lock-out that protected the pruned
      // aggregates has nothing left to protect. A reset is the documented way
      // back to a database every build can read.
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    // Deleting every row leaves the file exactly as large as it was, all of it
    // now free pages, and this store rewrites the whole file on every flush.
    // A reset is what someone reaches for when things have gone wrong; handing
    // back an empty database that still costs 70 MB a flush is a poor answer.
    this.compact();
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
            storageKey(rec.dedupKey),
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
        db.run(
          "DELETE FROM tool_event WHERE record_dedup_key = ?",
          [storageKey(rec.dedupKey)],
        );
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
            // Both are opaque on disk: one is the primary key, the other joins
            // back to usage_record. Nothing reads inside either.
            storageKey(evt.eventKey),
            storageKey(evt.recordDedupKey),
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
   *
   * `options.deferDerived` writes only the durable part — the usage rows, the
   * tool events and the cursor — and returns the keys whose derived rows still
   * need rebuilding. A large file is committed in many batches, and each
   * rebuild re-reads and re-prices the WHOLE session, so doing it per batch is
   * quadratic in the file's size. The caller accumulates the keys and passes
   * them back on the final commit, which rebuilds each one exactly once.
   *
   * A crash between a deferred commit and the final one leaves aggregates
   * stale against usage_record; that is what `aggregateIntegrity` +
   * `rebuildAggregates` already check for after every scan that changed data.
   */
  commitFileResult(
    fileId: string,
    batch: StoreBatch,
    decision: CatalogIngestDecision,
    pricing: PricingEngine,
    cursor: FileCursor,
    previousFileId = fileId,
    options: { deferDerived?: boolean; pendingKeys?: DerivedKeys } = {},
  ): DerivedKeys {
    const db = this.getDb();
    const statements: Statement[] = [];
    const prepare = (sql: string): Statement => {
      const statement = db.prepare(sql);
      statements.push(statement);
      return statement;
    };
    const dailyKeys = new Set<string>(options.pendingKeys?.daily);
    const sessionKeys = new Set<string>(options.pendingKeys?.session);
    const sessionModelKeys = new Set<string>(options.pendingKeys?.sessionModel);

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

      const insertRecord = prepare(
        `INSERT OR REPLACE INTO usage_record
         (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
          model, effort, variant_id, workspace, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, reasoning_tokens, total_tokens,
          context_window, context_used_tokens, is_sidechain, stop_reason, cost_usd, cost_unknown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      );
      for (const rec of batch.records) {
        const tsDate = new Date(rec.timestamp);
        const day = localDay(tsDate);
        const sessionModelKey = encodeKey(rec.source, rec.sessionId, rec.model);
        dailyKeys.add(encodeKey(day, rec.source, rec.variantId, rec.workspace ?? ""));
        sessionKeys.add(encodeKey(rec.source, rec.sessionId));
        sessionModelKeys.add(sessionModelKey);
        insertRecord.run([
          storageKey(rec.dedupKey), fileId, rec.source, rec.sessionId, rec.timestamp, day,
          tsDate.getDay(), tsDate.getHours(), rec.model, rec.effort ?? "n/a",
          rec.variantId, rec.workspace ?? "", rec.inputTokens, rec.outputTokens,
          rec.cacheReadTokens, rec.cacheCreationTokens, rec.reasoningTokens,
          totalTokens(rec), rec.meta?.contextWindow ?? null,
          rec.meta?.contextUsedTokens ?? null, rec.meta?.isSidechain ? 1 : 0,
          rec.meta?.stopReason ?? null,
        ]);
      }

      // Parser dedup keys include the file identity and byte offset, so a normal
      // first read/append cannot replace another record. Reingest deleted the
      // file's tool rows above; per-record DELETEs only added an indexed lookup
      // for every turn in the common path.

      if (batch.toolEvents.length > 0) {
        const insertToolEvent = prepare(
          `INSERT OR REPLACE INTO tool_event
           (event_key, record_dedup_key, file_id, source, session_id, ts_utc,
            day_local, tool_name, model, variant_id, workspace, is_sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?)`,
        );
        for (const evt of batch.toolEvents) {
          insertToolEvent.run([
            // Opaque on disk: one is the primary key, the other joins back to
            // usage_record, and nothing reads inside either.
            storageKey(evt.eventKey), storageKey(evt.recordDedupKey),
            fileId, evt.source, evt.sessionId,
            evt.timestamp, localDay(new Date(evt.timestamp)), evt.toolName,
            evt.isSidechain ? 1 : 0,
          ]);
        }
      }

      if (options.deferDerived) {
        // Rows and cursor are durable; the derived tables are rebuilt once, by
        // the final commit for this file.
        this.putCursor(cursor);
        db.run("COMMIT");
        return { daily: dailyKeys, session: sessionKeys, sessionModel: sessionModelKeys };
      }

      const updateRecordCost = prepare(
        "UPDATE usage_record SET cost_usd = ?, cost_unknown = ? WHERE dedup_key = ?",
      );
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
          updateRecordCost.run([cost.usd, cost.unknown ? 1 : 0, String(row[0])]);
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
      return { daily: dailyKeys, session: sessionKeys, sessionModel: sessionModelKeys };
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    } finally {
      for (const statement of statements) {
        statement.free();
      }
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
  updateMetaCounts(malformed: number, oversized: number, lostUsageLines = 0, recovered = 0): void {
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
    // Tracked apart from `oversized_line_count`: that one counts lines with no
    // token data in them, this one counts tokens actually missing from totals.
    if (lostUsageLines > 0) {
      db.run(
        `INSERT INTO meta (key, value) VALUES ('lost_usage_line_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
        [String(lostUsageLines), lostUsageLines],
      );
    }
    // Not a problem, but the number that proves the previous counter is a
    // real ceiling and not a silent drop.
    if (recovered > 0) {
      db.run(
        `INSERT INTO meta (key, value) VALUES ('oversized_recovered_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
        [String(recovered), recovered],
      );
    }
  }

  /** Reset the quality counters to 0 (called before a forceFull rescan). */
  resetQualityCounters(): void {
    const db = this.getDb();
    db.run(
      "DELETE FROM meta WHERE key IN ('malformed_line_count', 'oversized_line_count',"
      + " 'lost_usage_line_count', 'oversized_recovered_count')",
    );
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
    // DDL is invisible to total_changes(), so flag it explicitly.
    this.markStructurallyDirty();
    this.dropRedundantIndexes();
    // Runs last, after every step that may have left holes, so an upgrade that
    // both rewrites the keys and drops the indexes pays for one rewrite of the
    // file rather than two.
    this.compactIfPending();
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
                // What produced this cursor, not what would produce it today.
                update.run([LEGACY_V6_PARSE_REVISION, filePath]);
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

  /**
   * Replace every stored dedup key with its compact form.
   *
   * The keys held seventy bytes of structure that no query ever reads inside —
   * the column is a primary key, joined to `tool_event.record_dedup_key` and
   * compared for equality. On a real 122 MB database the structure cost 32 MB,
   * spread across the primary-key index, the tool-event rows that repeat the
   * key, and the cursor contributions that list them.
   *
   * Hashing whatever is stored is exactly what the write path now does to the
   * readable key, so a record ingested after this migration lands on the same
   * key as the one it replaces. That equivalence is the whole correctness
   * argument, and it is why this cannot be applied twice: the version check
   * above is what stops it.
   */
  private migrateV8ToV9(): void {
    const db = this.getDb();
    const before = this.migrationFingerprint();

    const stored = db.exec("SELECT dedup_key FROM usage_record");
    const keys = stored.length === 0 ? [] : stored[0].values.map((row) => String(row[0]));

    // 96 bits over a few million rows makes a collision vanishingly unlikely,
    // but a collision would silently replace one turn with another, so it is
    // checked rather than assumed.
    const shortByFull = new Map<string, string>();
    const fullByShort = new Map<string, string>();
    for (const full of keys) {
      const short = storageKey(full);
      const clash = fullByShort.get(short);
      if (clash !== undefined && clash !== full) {
        throw new Error(
          "Two usage records hash to the same compact dedup key; refusing to migrate",
        );
      }
      fullByShort.set(short, full);
      shortByFull.set(full, short);
    }

    db.run("BEGIN TRANSACTION");
    try {
      const updateRecord = db.prepare("UPDATE usage_record SET dedup_key = ? WHERE dedup_key = ?");
      try {
        for (const [full, short] of shortByFull) {
          updateRecord.run([short, full]);
          updateRecord.reset();
        }
      } finally {
        updateRecord.free();
      }

      // Tool events carry the key twice: once as their own primary key, once as
      // the link back. Both are opaque, so both become the hash of what was
      // there — which is what the write path produces for a new event.
      const events = db.exec("SELECT event_key, record_dedup_key FROM tool_event");
      if (events.length > 0) {
        const updateEvent = db.prepare(
          "UPDATE tool_event SET event_key = ?, record_dedup_key = ? WHERE event_key = ?",
        );
        try {
          for (const row of events[0].values) {
            const eventKey = String(row[0]);
            updateEvent.run([storageKey(eventKey), storageKey(String(row[1])), eventKey]);
            updateEvent.reset();
          }
        } finally {
          updateEvent.free();
        }
      }

      // Cursor contributions list the keys of the records a file produced, and
      // are compared against stored keys to spot an overlapping re-read.
      const cursors = db.exec("SELECT file_path, contribution FROM file_cursor");
      if (cursors.length > 0) {
        const updateCursor = db.prepare("UPDATE file_cursor SET contribution = ? WHERE file_path = ?");
        try {
          for (const row of cursors[0].values) {
            const filePath = String(row[0]);
            const contribution = JSON.parse(String(row[1])) as { recordKeys?: unknown };
            if (!Array.isArray(contribution.recordKeys)) { continue; }
            contribution.recordKeys = contribution.recordKeys.map((key) => storageKey(String(key)));
            updateCursor.run([JSON.stringify(contribution), filePath]);
            updateCursor.reset();
          }
        } finally {
          updateCursor.free();
        }
      }

      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const after = this.migrationFingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Compacting the dedup keys changed canonical usage data");
    }
    // Rewriting every primary key churns the index, and the file keeps the space
    // the old keys occupied until it is squeezed out. Deferred rather than done
    // here: dropping the redundant indexes right afterwards would otherwise pay
    // for a second full rewrite of the same file.
    this.compactionPending = true;
  }

  /**
   * Drop two indexes that never earned their keep, if they are still there.
   *
   * `idx_rec_session(source, session_id)` is a leading prefix of
   * `idx_rec_session_model`, and `idx_rec_day(day_local)` a prefix of
   * `idx_rec_daily_key`. SQLite answers the same lookups from the wider index
   * by the same access path — verified against a real 162k-row database, where
   * the pair cost 10.9 MB and turned no SEARCH into a SCAN.
   *
   * Deliberately not a schema migration. No code names an index, so a database
   * without them is still a version 8 database that every shipped build reads
   * correctly; running this as idempotent maintenance instead means upgrading
   * costs an existing user nothing, not even a window reload.
   */
  private dropRedundantIndexes(): void {
    const db = this.getDb();
    const present = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN "
      + "('idx_rec_session', 'idx_rec_day')",
    );
    if (present.length === 0 || present[0].values.length === 0) { return; }

    const before = this.migrationFingerprint();
    db.run("DROP INDEX IF EXISTS idx_rec_session");
    db.run("DROP INDEX IF EXISTS idx_rec_day");
    this.markStructurallyDirty();
    // Dropping an index frees pages inside the file without shrinking it, so the
    // space is reclaimed on paper only until the file is rewritten.
    this.compactionPending = true;
    const after = this.migrationFingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Dropping the redundant indexes changed canonical usage data");
    }
  }

  /**
   * Set when something has freed pages that only a rewrite gives back.
   *
   * An upgrade can do two of those in a row — rewriting every dedup key and
   * dropping two indexes — and each rewrite of a 122 MB file costs the better
   * part of a second, so they are collapsed into one.
   */
  private compactionPending = false;

  /** Rewrite the file if anything has left holes in it, at most once. */
  compactIfPending(): boolean {
    if (!this.compactionPending) { return false; }
    this.compactionPending = false;
    this.compact();
    return true;
  }

  /**
   * Rewrite the database without its free pages.
   *
   * Deletes and dropped indexes leave holes that SQLite reuses but never gives
   * back, and this store persists by writing the whole file — so a hole is paid
   * for on every single flush until it is squeezed out. VACUUM cannot run inside
   * a transaction, hence the separate step.
   */
  compact(): { pagesBefore: number; pagesAfter: number } {
    const db = this.getDb();
    const pages = () => Number(db.exec("PRAGMA page_count")[0].values[0][0]);
    const pagesBefore = pages();
    db.run("VACUUM");
    // VACUUM moves no rows, so total_changes() does not see it.
    this.markStructurallyDirty();
    return { pagesBefore, pagesAfter: pages() };
  }

  /**
   * The first local day for which raw `usage_record` rows still exist.
   *
   * `undefined` means nothing has been pruned and every day is complete. Once
   * set it is a hard promise the rest of the code relies on: no day before it
   * holds any raw row, and no session with a row before it holds one after it
   * either. `rebuildAggregates` leans on that to know which pre-computed
   * aggregates it must leave alone, because they can no longer be recomputed.
   */
  retainedFromDay(): string | undefined {
    return this.getMeta(RETAINED_FROM_DAY_KEY);
  }

  /**
   * Delete raw rows older than `retentionDays`, in whole days.
   *
   * Raw rows are what `daily_aggregate` and `session_aggregate` are derived
   * from, and those aggregates are what the dashboard reads — so the history
   * survives pruning. What is given up is per-hour drill-down and tool detail
   * for old days, and the ability to reprice them if rates change.
   *
   * The cutoff is pulled earlier when a session is still running across it. A
   * half-pruned day or session would make the next aggregate rebuild recompute
   * it from what was left and silently shrink the totals, so nothing partial is
   * ever left behind.
   */
  pruneRawRecords(retentionDays: number, now = Date.now()): PruneOutcome {
    const unchanged: PruneOutcome = {
      prunedRecords: 0,
      prunedToolEvents: 0,
      retainedFromDay: this.retainedFromDay(),
    };
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return unchanged;
    }
    const db = this.getDb();
    const cutoffDay = localDayFromMs(now - retentionDays * RETENTION_DAY_MS);
    const cutoffTs = parseLocalDay(cutoffDay).getTime();

    // Earliest day touched by a session that is still active at or past the
    // cutoff. Its rows have to stay whole, so the cutoff cannot pass it.
    const straddling = db.exec(
      "SELECT MIN(r.day_local) FROM usage_record r JOIN ("
      + " SELECT source, session_id FROM usage_record"
      + " GROUP BY source, session_id HAVING MAX(ts_utc) >= ?"
      + ") live ON live.source = r.source AND live.session_id = r.session_id",
      [cutoffTs],
    );
    const straddlingDay = straddling[0]?.values[0]?.[0];
    const effectiveDay = typeof straddlingDay === "string" && straddlingDay < cutoffDay
      ? straddlingDay
      : cutoffDay;

    const before = Number(db.exec("SELECT COUNT(*) FROM usage_record")[0].values[0][0]);
    if (before === 0) {
      return unchanged;
    }
    const oldestDay = db.exec("SELECT MIN(day_local) FROM usage_record")[0].values[0][0];
    if (typeof oldestDay !== "string" || oldestDay >= effectiveDay) {
      // Nothing old enough to remove, but the promise still holds and a rebuild
      // needs to know it.
      this.setMeta(RETAINED_FROM_DAY_KEY, effectiveDay);
      return { ...unchanged, retainedFromDay: effectiveDay };
    }

    const toolsBefore = Number(db.exec("SELECT COUNT(*) FROM tool_event")[0].values[0][0]);
    this.markStructurallyDirty();
    db.run("BEGIN TRANSACTION");
    try {
      db.run("DELETE FROM tool_event WHERE day_local < ?", [effectiveDay]);
      db.run("DELETE FROM usage_record WHERE day_local < ?", [effectiveDay]);
      db.run(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        [RETAINED_FROM_DAY_KEY, effectiveDay],
      );
      // Aggregates now outlive the rows behind them. A build that predates
      // retention reads that as corruption and rebuilds them from what is left,
      // which deletes the history; refusing at its version check is the only
      // way to stop it, since it is already shipped. A reset undoes this.
      db.run(
        "UPDATE meta SET value = ? WHERE key = 'schema_version'",
        [String(PRUNED_SCHEMA_VERSION)],
      );
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
    const prunedRecords = before
      - Number(db.exec("SELECT COUNT(*) FROM usage_record")[0].values[0][0]);
    const prunedToolEvents = toolsBefore
      - Number(db.exec("SELECT COUNT(*) FROM tool_event")[0].values[0][0]);
    // Deleted rows leave free pages, and this store writes the whole file on
    // every flush, so skipping the compaction would make a prune cost disk
    // rather than save it.
    if (prunedRecords > 0 || prunedToolEvents > 0) {
      this.compact();
    }
    return { prunedRecords, prunedToolEvents, retainedFromDay: effectiveDay };
  }

  /** Free pages as a fraction of the file — how much a compaction would return. */
  fragmentation(): number {
    const db = this.getDb();
    const pages = Number(db.exec("PRAGMA page_count")[0].values[0][0]);
    if (pages === 0) { return 0; }
    return Number(db.exec("PRAGMA freelist_count")[0].values[0][0]) / pages;
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

function fileIdentity(path: string): string {
  const stats = statSync(path, { bigint: true });
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

function readStableSnapshot(path: string): { buffer: Buffer; identity: string } {
  for (let attempt = 0; attempt < SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
    try {
      const identityBefore = fileIdentity(path);
      const buffer = readFileSync(path);
      const identityAfter = fileIdentity(path);
      if (identityBefore === identityAfter) {
        return { buffer, identity: identityAfter };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new ConcurrentUsageStoreWriteError();
}

function acquireWriteLock(lockPath: string): { fd: number; owner: string } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      let ownerPid: number;
      let lockAgeMs: number;
      try {
        ownerPid = Number(readFileSync(lockPath, "utf8").split(":", 1)[0]);
        lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      const ownerIsDead = Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid);
      if (attempt === 0 && (ownerIsDead || lockAgeMs > WRITE_LOCK_STALE_MS)) {
        try { unlinkSync(lockPath); } catch { /* another process recovered it */ }
        continue;
      }
      throw new ConcurrentUsageStoreWriteError();
    }
    const owner = `${process.pid}:${randomUUID()}`;
    try {
      writeFileSync(fd, owner);
      return { fd, owner };
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
  throw new ConcurrentUsageStoreWriteError();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
