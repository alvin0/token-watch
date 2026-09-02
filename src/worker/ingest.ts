/**
 * Ingestion driver — decision matrix + file processing pipeline.
 *
 * For each candidate file, decides: skip / append / reingest / firstRead.
 * Then parses, normalizes, prices, and applies the result to the store.
 *
 * This module MUST NOT import `vscode`.
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 4.24, 4.25, 4.26
 */

import type { CandidateFile } from "./discovery";
import type { DerivedKeys, FileCursorHeader, UsageStore } from "./store/UsageStore";
import type { FileCursor, FileContribution } from "../shared/storeTypes";
import type { UsageRecord, ToolEvent, Source, TokenSums } from "../shared/types";
import { totalTokens } from "../shared/types";
import { computeHeadHash, computeTailAnchorHash } from "./cursor";
import { CodexParser } from "./parsers/codex";
import { ClaudeParser } from "./parsers/claude";
import { normalize } from "./normalizer";
import { LONG_CONTEXT_THRESHOLD_TOKENS, PricingEngine } from "./pricing";
import { localDay, localDayFromMs } from "../shared/time";
import { storageKey } from "./store/dedupKey.js";
import type { ParseOutput, ResumeState } from "./parsers/types";
import { parseRevisionForSource } from "./parsers/revision";
import type { FileQuarantine } from "./quarantine";
import { rebuildAggregates } from "./store/queries";

export type IngestDecision = "skip" | "append" | "reingest" | "firstRead";

export interface IngestResult {
  processed: number;
  skipped: number;
  appended: number;
  reingested: number;
  firstReads: number;
  /** Files that threw and were quarantined instead of aborting the scan. */
  failed: number;
  /** Files skipped because they are still inside a quarantine backoff window. */
  quarantined: number;
  /** Oversized lines parsed anyway because they carried token data. */
  oversizedRecovered: number;
  /** Oversized lines whose token data could not be read — the only real loss. */
  oversizedLostUsage: number;
  /** Failed files that had already committed at least one batch. */
  partialCommits: number;
  /** True when the scan stopped before processing every candidate. */
  stoppedEarly: boolean;
}

export function hasIngestedChanges(result: IngestResult): boolean {
  // `partialCommits` counts files that wrote at least one batch and THEN threw.
  // Those rows are in the database; leaving them out of this made the host
  // report "nothing changed", so the panel never refreshed, unmapped-model
  // pricing was never recomputed, and the snapshot could stay unflushed.
  return result.appended + result.reingested + result.firstReads + result.partialCommits > 0;
}

/**
 * A file that committed some batches before failing.
 *
 * Carries the count so the caller can tell "nothing happened" apart from
 * "something happened and then it broke" — the two need different handling.
 */
export class PartialIngestError extends Error {
  constructor(
    readonly committedBatches: number,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PartialIngestError";
  }
}

export function isPartialIngestError(error: unknown): error is PartialIngestError {
  return error instanceof PartialIngestError;
}

export interface IngestOptions {
  maxLineBytes: number;
  backfillMonths: number;
  /**
   * Called after each batch is committed to the in-memory database, and after
   * each file completes.
   *
   * A parser checkpoint alone is not durable: it only reaches sql.js's memory,
   * and the snapshot is written when the scan ends. The worker uses this to
   * persist on a time throttle, so an interrupted scan keeps its progress.
   */
  onCheckpoint?: () => void;
  /**
   * Checked between files AND between the batches of one file; returning true
   * ends the scan early.
   *
   * Shutdown uses it so the final flush waits for the current batch rather
   * than a whole file, which for a large log can exceed the host's deadline
   * and get the worker terminated with the batch still unwritten.
   */
  shouldStop?: () => boolean;
  /**
   * Bulk-load mode for an empty database: persist raw rows/cursors per file,
   * then price and rebuild all derived rows once after the scan.
   */
  deferDerivedUntilEnd?: boolean;
}

const SMALL_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;
const RECENT_FILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORED_PRIORITY_LIMIT = 500;
/** Progress placeholder for a file that was not read at all. */
const EMPTY_FILE_RESULT: FileIngestResult = {
  decision: "skip",
  malformedCount: 0,
  oversizedCount: 0,
  oversizedRecoveredCount: 0,
  oversizedLostUsageCount: 0,
};
const EVENT_LOOP_YIELD_INTERVAL = 25;

/**
 * Pure decision function — no I/O. Determines what action to take for a
 * candidate file given its current cursor state.
 */
export function decideAction(
  candidate: CandidateFile,
  cursor: FileCursorHeader | FileCursor | undefined,
): IngestDecision {
  if (!cursor) {
    return "firstRead";
  }
  if (candidate.fileId !== cursor.fileId) {
    return "reingest";
  }
  if (cursor.parseRevision !== parseRevisionForSource(candidate.source)) {
    return "reingest";
  }
  // Skip: size+mtime unchanged (Req 4.6)
  if (candidate.size === cursor.size && candidate.mtimeMs === cursor.mtimeMs) {
    return "skip";
  }
  // Append conditions: file grew or same size but mtime changed, need hash checks.
  // But hash checks require I/O — at this level we can only rule out shrink.
  if (candidate.size < cursor.lastByteOffset) {
    return "reingest";
  }
  // Size >= lastByteOffset — potential append, but needs hash verification in ingestFile.
  return "append";
}

/**
 * Turns accumulated before a parser hands off a committable batch. Bounds peak
 * memory on a single very large session log: without it, every turn and tool
 * event of a multi-GB file is held until the file is fully read.
 */
export const CHECKPOINT_TURNS = 5_000;

/**
 * Process a single candidate file: decide action, perform I/O (hash checks,
 * parsing), normalize, price, build batches, apply each to the store, and
 * advance the cursor.
 *
 * A parse can yield several batches. Each is committed as it arrives with a
 * cursor checkpoint, so a crash or a shutdown mid-file loses at most the last
 * partial batch instead of every byte read so far.
 */
export async function ingestFile(
  candidate: CandidateFile,
  store: UsageStore,
  pricing: PricingEngine,
  options: IngestOptions,
): Promise<FileIngestResult> {
  const empty = (d: IngestDecision): FileIngestResult => ({
    decision: d, malformedCount: 0, oversizedCount: 0,
    oversizedRecoveredCount: 0, oversizedLostUsageCount: 0,
  });

  const cursorHeader = store.getCursorHeader(candidate.filePath);
  let decision = decideAction(candidate, cursorHeader);

  if (decision === "skip") {
    return empty("skip");
  }
  const cursor = cursorHeader ? store.getCursor(candidate.filePath) : undefined;

  // Backfill cap: on first reads only, skip files older than backfillMonths (Req 4.24)
  // backfillMonths === 0 means unlimited (no cap).
  // We deliberately do NOT persist a cursor for backfill-skipped files: the skip
  // happens before any file I/O (only the discovery stat, which runs regardless),
  // so there is nothing to save. If such a file is later modified, its mtime moves
  // past the cutoff and it is correctly ingested as a full firstRead (offset 0,
  // proper running totals) rather than a partial append against an empty baseline.
  if (decision === "firstRead" && options.backfillMonths > 0) {
    const cutoff = Date.now() - options.backfillMonths * 30 * 24 * 60 * 60 * 1000;
    if (candidate.mtimeMs < cutoff) {
      return empty("skip");
    }
  }

  // For append: verify hashes (requires I/O). If they fail -> reingest.
  if (decision === "append" && cursor) {
    const headHash = computeHeadHash(candidate.filePath, candidate.size);
    if (headHash !== cursor.headHash) {
      decision = "reingest";
    } else {
      const tailAnchor = computeTailAnchorHash(candidate.filePath, cursor.lastByteOffset);
      if (tailAnchor !== cursor.tailAnchorHash) {
        decision = "reingest";
      }
    }
  }

  const parser = candidate.source === "codex" ? new CodexParser() : new ClaudeParser();
  const parseForDecision = async (
    parseDecision: IngestDecision,
    onBatch: (batch: ParseOutput) => void,
  ): Promise<void> => {
    const startOffset = parseDecision === "append" && cursor ? cursor.lastByteOffset : 0;
    const resumeState: ResumeState | undefined =
      parseDecision === "append" && cursor
        ? { runningTotals: cursor.runningTotals, recentRequestIds: cursor.recentRequestIds }
        : undefined;

    await parser.parse(
      {
        filePath: candidate.filePath,
        fileId: candidate.fileId,
        startOffset,
        endOffset: candidate.size,
        maxLineBytes: options.maxLineBytes,
        checkpointTurns: CHECKPOINT_TURNS,
        resumeState,
      },
      onBatch,
    );
  };

  const run = await runIngestPass(decision, candidate, store, pricing, cursor, parseForDecision, options);

  if (run.outcome === "needsFullReingest") {
    // Nothing was committed on the first pass, so a clean full re-parse is safe.
    const reparse = await runIngestPass("reingest", candidate, store, pricing, cursor, parseForDecision, options);
    if (reparse.outcome !== "committed") {
      return { ...countsOf(reparse), decision: "skip" };
    }
    return { ...countsOf(reparse), decision: "reingest" };
  }

  if (run.outcome === "noOutput") {
    // No parseable content - still record the current stat so the next scan skips.
    const headHash = computeHeadHash(candidate.filePath, candidate.size);
    const tailAnchor = computeTailAnchorHash(candidate.filePath, candidate.size);
    const emptyContribution: FileContribution = {
      daily: [], sessions: [], recordKeys: [], toolEventCount: 0,
    };
    store.putCursor({
      filePath: candidate.filePath,
      fileId: candidate.fileId,
      source: candidate.source,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      lastByteOffset: candidate.size,
      headHash,
      tailAnchorHash: tailAnchor,
      runningTotals: {},
      recentRequestIds: [],
      parseRevision: parseRevisionForSource(candidate.source),
      contribution: decision === "append" && cursor ? cursor.contribution : emptyContribution,
    });
    return empty(decision);
  }

  if (run.outcome === "truncated") {
    // The parse stopped short of the announced size (an incomplete trailing
    // line, or the file shrank). Anything already checkpointed stands; the rest
    // is picked up on the next scan.
    return { ...countsOf(run), decision: run.committedBatches > 0 ? run.decision : "skip" };
  }

  return { ...countsOf(run), decision: run.decision };
}

/** The quality counters a pass accumulated, in FileIngestResult shape. */
function countsOf(run: IngestPassResult): Omit<FileIngestResult, "decision"> {
  return {
    malformedCount: run.malformedCount,
    oversizedCount: run.oversizedCount,
    oversizedRecoveredCount: run.oversizedRecoveredCount,
    oversizedLostUsageCount: run.oversizedLostUsageCount,
  };
}

interface IngestPassResult {
  outcome: "committed" | "noOutput" | "truncated" | "needsFullReingest";
  decision: IngestDecision;
  committedBatches: number;
  malformedCount: number;
  oversizedCount: number;
  oversizedRecoveredCount: number;
  oversizedLostUsageCount: number;
}

/**
 * Drive one parse and commit its batches.
 *
 * The last batch is held back until either another batch arrives (proving the
 * reader moved past it on a line boundary) or the parse finishes with its
 * endOffset reaching the announced size. That keeps the pre-existing rule -
 * never commit a parse that stopped short - while still checkpointing.
 */
async function runIngestPass(
  decision: IngestDecision,
  candidate: CandidateFile,
  store: UsageStore,
  pricing: PricingEngine,
  cursor: FileCursor | undefined,
  parseForDecision: (d: IngestDecision, onBatch: (batch: ParseOutput) => void) => Promise<void>,
  options: IngestOptions,
): Promise<IngestPassResult> {
  const headHash = computeHeadHash(candidate.filePath, candidate.size);
  let runningContribution: FileContribution = decision === "append" && cursor
    ? cursor.contribution
    : { daily: [], sessions: [], recordKeys: [], toolEventCount: 0 };

  let commitDecision: IngestDecision = decision;
  let committedBatches = 0;
  /**
   * Aggregate rows the checkpoint commits have invalidated.
   *
   * Rebuilding them per batch re-reads and re-prices the whole session each
   * time, which is quadratic in the file's size; they are settled once by the
   * final commit instead.
   */
  let pendingKeys: DerivedKeys | undefined;
  let malformedCount = 0;
  let oversizedCount = 0;
  let oversizedRecoveredCount = 0;
  let oversizedLostUsageCount = 0;
  let sawBatch = false;
  let needsFullReingest = false;
  let stopped = false;
  let held: ParseOutput | undefined;

  // Days below this were pruned by retention and their aggregates are now the
  // only record of them. Letting a re-read put a handful of raw rows back would
  // make the next aggregate rebuild recompute those days from the fragment and
  // silently shrink the totals.
  const retainedFrom = store.retainedFromDay();
  const isRetained = (day: string): boolean => retainedFrom === undefined || day >= retainedFrom;

  const commit = (batch: ParseOutput, isFinal: boolean): void => {
    const parsedRecords: UsageRecord[] = batch.rawTurns
      .map(normalize)
      .filter((r) => r.timestamp > 0 && isRetained(localDayFromMs(r.timestamp)));
    const parsedToolEvents: ToolEvent[] = batch.toolEvents
      .filter((e) => e.timestamp > 0 && isRetained(localDayFromMs(e.timestamp)));
    const { records, toolEvents } = dedupeParsedRecords(parsedRecords, parsedToolEvents);

    if (
      committedBatches === 0 &&
      decision === "append" &&
      cursor &&
      (
        hasOverlappingRecordKeys(cursor.contribution, records) ||
        shouldReingestForLongContextCrossing(cursor, batch, records, pricing)
      )
    ) {
      // The append boundary is unreliable; the caller re-runs from offset 0.
      needsFullReingest = true;
      return;
    }

    const contribution = buildContribution(records, toolEvents, pricing);
    const finalContribution = commitDecision === "append"
      ? mergeContributions(runningContribution, contribution)
      : contribution;

    // A mid-file checkpoint records how far the file has been consumed, not the
    // file's full size - otherwise the next scan would see size+mtime unchanged
    // and skip the remainder forever.
    const cursorSize = isFinal ? candidate.size : batch.endOffset;
    const nextCursor: FileCursor = {
      filePath: candidate.filePath,
      fileId: candidate.fileId,
      source: candidate.source,
      size: cursorSize,
      mtimeMs: candidate.mtimeMs,
      lastByteOffset: batch.endOffset,
      headHash,
      tailAnchorHash: computeTailAnchorHash(candidate.filePath, batch.endOffset),
      runningTotals: batch.endState.runningTotals,
      recentRequestIds: batch.endState.recentRequestIds,
      parseRevision: parseRevisionForSource(candidate.source),
      contribution: finalContribution,
    };

    pendingKeys = store.commitFileResult(
      candidate.fileId,
      { records, toolEvents, contribution },
      commitDecision,
      pricing,
      nextCursor,
      cursor?.fileId,
      { deferDerived: !isFinal || options.deferDerivedUntilEnd, ...(pendingKeys ? { pendingKeys } : {}) },
    );
    if (isFinal && !options.deferDerivedUntilEnd) { pendingKeys = undefined; }

    runningContribution = finalContribution;
    committedBatches++;
    // Later batches extend what the first one wrote; never re-clear the file.
    commitDecision = "append";
    options.onCheckpoint?.();
  };

  try {
    await parseForDecision(decision, (batch) => {
      sawBatch = true;
      malformedCount += batch.malformedCount;
      oversizedCount += batch.oversizedCount;
      oversizedRecoveredCount += batch.oversizedRecoveredCount;
      oversizedLostUsageCount += batch.oversizedLostUsageCount;
      if (needsFullReingest) { return; }
      if (held) {
        commit(held, false);
        held = undefined;
        if (needsFullReingest) { return; }
      }
      held = batch;
      if (options.shouldStop?.()) {
        // Commit what is in hand so the checkpoint is durable, then stop; the
        // rest of the file resumes from this cursor on the next scan.
        commit(held, false);
        held = undefined;
        stopped = true;
      }
    });
  } catch (error) {
    // Anything already committed is durable; say so rather than letting the
    // caller assume the file left the database untouched.
    throw committedBatches > 0 ? new PartialIngestError(committedBatches, error) : error;
  }

  if (needsFullReingest) {
    return { outcome: "needsFullReingest", decision, committedBatches, malformedCount, oversizedCount, oversizedRecoveredCount, oversizedLostUsageCount };
  }
  if (stopped) {
    // Everything committed is durable and the cursor points part-way through
    // the file; treat it exactly like a parse that stopped short.
    return { outcome: "truncated", decision, committedBatches, malformedCount, oversizedCount, oversizedRecoveredCount, oversizedLostUsageCount };
  }
  if (!sawBatch) {
    return { outcome: "noOutput", decision, committedBatches, malformedCount, oversizedCount, oversizedRecoveredCount, oversizedLostUsageCount };
  }
  if (held) {
    if (held.endOffset < candidate.size) {
      return { outcome: "truncated", decision, committedBatches, malformedCount, oversizedCount, oversizedRecoveredCount, oversizedLostUsageCount };
    }
    try {
      commit(held, true);
    } catch (error) {
      throw committedBatches > 0 ? new PartialIngestError(committedBatches, error) : error;
    }
    if (needsFullReingest) {
      return { outcome: "needsFullReingest", decision, committedBatches, malformedCount, oversizedCount, oversizedRecoveredCount, oversizedLostUsageCount };
    }
  }

  return {
    outcome: committedBatches > 0 ? "committed" : "truncated",
    decision,
    committedBatches,
    malformedCount,
    oversizedCount,
    oversizedRecoveredCount,
    oversizedLostUsageCount,
  };
}

/**
 * Ingest all candidate files with a recency-first strategy for fresh data:
 *
 * Phase 1 (fresh): Process files modified in the recent window first, newest
 * first, even when they are large active sessions.
 *
 * Phase 2 (backfill): Process older small files before older large files so
 * historical backfill remains responsive.
 */
export async function ingestAll(
  candidates: CandidateFile[],
  store: UsageStore,
  pricing: PricingEngine,
  options: IngestOptions,
  onProgress?: (processed: number, total: number, fileResult: FileIngestResult) => void,
  quarantine?: FileQuarantine,
  onFileError?: (candidate: CandidateFile, error: unknown) => void,
): Promise<IngestResult> {
  const result: IngestResult = {
    processed: 0,
    skipped: 0,
    appended: 0,
    reingested: 0,
    firstReads: 0,
    failed: 0,
    quarantined: 0,
    oversizedRecovered: 0,
    oversizedLostUsage: 0,
    partialCommits: 0,
    stoppedEarly: false,
  };

  const ranked = rankCandidatesForIngestion(candidates, store);
  store.recordFileCatalogPriorities(ranked.slice(0, STORED_PRIORITY_LIMIT).map(({ candidate, priorityScore }) => ({
    filePath: candidate.filePath,
    priorityScore,
  })));
  const ordered = ranked.map(({ candidate }) => candidate);
  const total = ordered.length;

  let totalMalformed = 0;
  let totalOversized = 0;

  for (let i = 0; i < total; i++) {
    if (options.shouldStop?.()) {
      // Everything committed so far stands and its cursors are persisted; the
      // remaining candidates are picked up by the next scan.
      result.stoppedEarly = true;
      break;
    }
    const candidate = ordered[i];

    // A file inside its backoff window costs nothing to skip; the discovery
    // stat already ran, and retrying it every 10s only repeats the same error.
    if (quarantine?.shouldSkip(candidate.filePath)) {
      result.processed++;
      result.quarantined++;
      result.skipped++;
      onProgress?.(result.processed, total, EMPTY_FILE_RESULT);
      continue;
    }

    let fileResult: FileIngestResult;
    try {
      fileResult = await ingestFile(candidate, store, pricing, options);
    } catch (error) {
      // Isolate the failure: a file that vanished mid-scan, or that the OS
      // refuses to read, must not stop every candidate ranked behind it.
      quarantine?.recordFailure(candidate.filePath, error);
      onFileError?.(candidate, error);
      result.processed++;
      result.failed++;
      if (isPartialIngestError(error) && error.committedBatches > 0) {
        // Its rows are already in the database, so the scan really did change
        // data even though this file did not finish.
        result.partialCommits++;
      }
      onProgress?.(result.processed, total, EMPTY_FILE_RESULT);
      if (result.processed % EVENT_LOOP_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
      continue;
    }

    quarantine?.recordSuccess(candidate.filePath);
    store.recordFileCatalogIngestResult(candidate, fileResult.decision);
    options.onCheckpoint?.();
    result.processed++;
    switch (fileResult.decision) {
      case "skip": result.skipped++; break;
      case "append": result.appended++; break;
      case "reingest": result.reingested++; break;
      case "firstRead": result.firstReads++; break;
    }
    totalMalformed += fileResult.malformedCount;
    totalOversized += fileResult.oversizedCount;
    result.oversizedRecovered += fileResult.oversizedRecoveredCount;
    result.oversizedLostUsage += fileResult.oversizedLostUsageCount;
    onProgress?.(result.processed, total, fileResult);
    if (result.processed % EVENT_LOOP_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  // Persist quality metrics — incremental appends only see new issues, so we
  // accumulate. forceFull rescans reset these counters beforehand.
  store.updateMetaCounts(
    totalMalformed, totalOversized, result.oversizedLostUsage, result.oversizedRecovered,
  );

  // Record last ingest run timestamp
  store.setMeta("last_ingest_run_utc", String(Date.now()));

  if (options.deferDerivedUntilEnd && hasIngestedChanges(result)) {
    rebuildAggregates(store.database, pricing);
  }

  // Record unmapped models — evaluate against ALL models in the store, not just
  // those parsed this run, so a watch tick on one file doesn't clobber the set.
  if (hasIngestedChanges(result)) {
    const unmapped = pricing.unmappedModels(store.distinctModels());
    store.recordUnmappedModels(unmapped, pricing.fallbackModelRate());
  }

  return result;
}

export function orderCandidatesForIngestion(candidates: CandidateFile[], now = Date.now()): CandidateFile[] {
  return rankCandidatesForIngestion(candidates, undefined, now).map(({ candidate }) => candidate);
}

export function rankCandidatesForIngestion(
  candidates: CandidateFile[],
  store?: UsageStore,
  now = Date.now(),
): Array<{ candidate: CandidateFile; priorityScore: number }> {
  return candidates
    .map((candidate) => {
      const rankInfo = store?.getCursorRankInfo(candidate.filePath);
      return {
        candidate,
        priorityScore: candidatePriorityScore(
          candidate,
          rankInfo?.cursor,
          now,
          rankInfo?.minDay && rankInfo.maxDay
            ? { minDay: rankInfo.minDay, maxDay: rankInfo.maxDay }
            : undefined,
        ),
      };
    })
    .sort((a, b) =>
      b.priorityScore - a.priorityScore ||
      b.candidate.mtimeMs - a.candidate.mtimeMs ||
      a.candidate.filePath.localeCompare(b.candidate.filePath)
    );
}

export function candidatePriorityScore(
  candidate: CandidateFile,
  cursor: FileCursorHeader | FileCursor | undefined,
  now = Date.now(),
  knownDayRange?: { minDay: string; maxDay: string },
): number {
  const todayStart = startOfLocalDayMs(now);
  const weekStartDay = localDay(new Date(todayStart - 6 * DAY_MS));
  const today = localDay(new Date(now));
  const recentCutoff = now - RECENT_FILE_WINDOW_MS;
  const dayRange = knownDayRange ?? (cursor && "contribution" in cursor
    ? dayRangeFromContribution(cursor.contribution)
    : undefined);
  const isNew = !cursor;
  const changed = cursor
    ? candidate.fileId !== cursor.fileId || candidate.size !== cursor.size || candidate.mtimeMs !== cursor.mtimeMs
    : false;
  const overlapsToday = dayRange ? dayRange.minDay <= today && dayRange.maxDay >= today : false;
  const overlapsWeek = dayRange ? dayRange.maxDay >= weekStartDay && dayRange.minDay <= today : false;

  let score = 0;
  if (isNew) { score += 20_000; }
  if (changed) { score += 15_000; }
  if (candidate.mtimeMs >= todayStart) { score += 10_000; }
  if (overlapsToday) { score += 8_000; }
  if (overlapsWeek) { score += 4_000; }
  if (candidate.mtimeMs >= recentCutoff) { score += 3_000; }
  if (candidate.size < SMALL_FILE_THRESHOLD_BYTES) { score += 200; }
  score += recencyScore(candidate.mtimeMs, now);

  if (!isNew && !changed && dayRange && dayRange.maxDay < weekStartDay) {
    score -= 5_000;
  }

  return score;
}

function recencyScore(mtimeMs: number, now: number): number {
  const ageHours = Math.max(0, (now - mtimeMs) / (60 * 60 * 1000));
  return Math.max(0, 1_000 - ageHours);
}

function startOfLocalDayMs(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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
  return minDay && maxDay ? { minDay, maxDay } : undefined;
}

function hasOverlappingRecordKeys(contribution: FileContribution, records: UsageRecord[]): boolean {
  if (records.length === 0 || contribution.recordKeys.length === 0) {
    return false;
  }
  // A cursor's keys are in stored form, so both sides are hashed before they
  // are compared. The legacy shape is still built from the readable key first,
  // which is why hashing happens here and not where keys are created.
  const existingKeys = new Set(contribution.recordKeys);
  return records.some((record) => {
    if (existingKeys.has(storageKey(record.dedupKey))) {
      return true;
    }
    const legacyKey = legacyClaudeRecordKey(record);
    return legacyKey ? existingKeys.has(storageKey(legacyKey)) : false;
  });
}

function legacyClaudeRecordKey(record: UsageRecord): string | undefined {
  if (record.source !== "claude") {
    return undefined;
  }
  const parts = record.dedupKey.split(":");
  if (parts.length < 5) {
    return undefined;
  }
  return `claude:${record.sessionId}:${parts[3]}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function dedupeParsedRecords(
  records: UsageRecord[],
  toolEvents: ToolEvent[],
): { records: UsageRecord[]; toolEvents: ToolEvent[] } {
  const latestRecords = new Map<string, UsageRecord>();
  for (const rec of records) {
    latestRecords.delete(rec.dedupKey);
    latestRecords.set(rec.dedupKey, rec);
  }

  const recordTimestamps = new Map<string, number>();
  for (const rec of latestRecords.values()) {
    recordTimestamps.set(rec.dedupKey, rec.timestamp);
  }

  const latestToolEvents = new Map<string, ToolEvent>();
  for (const event of toolEvents) {
    if (recordTimestamps.get(event.recordDedupKey) !== event.timestamp) {
      continue;
    }
    latestToolEvents.delete(event.eventKey);
    latestToolEvents.set(event.eventKey, event);
  }

  return {
    records: [...latestRecords.values()],
    toolEvents: [...latestToolEvents.values()],
  };
}

/** Result from processing a single file. */
export interface FileIngestResult {
  decision: IngestDecision;
  malformedCount: number;
  /** Oversized lines that carried no token data; nothing countable was lost. */
  oversizedCount: number;
  /** Oversized lines parsed anyway because they carried token data. */
  oversizedRecoveredCount: number;
  /** Oversized lines too large to buffer that carried token data — real loss. */
  oversizedLostUsageCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function shouldReingestForLongContextCrossing(
  cursor: FileCursor,
  parseOutput: ParseOutput,
  parsedRecords: UsageRecord[],
  pricing: PricingEngine,
): boolean {
  const modelsBySession = new Map<string, Set<string>>();
  for (const rec of parsedRecords) {
    if (!pricing.hasLongContextRate(rec.model)) {
      continue;
    }
    const models = modelsBySession.get(rec.sessionId) ?? new Set<string>();
    models.add(rec.model);
    modelsBySession.set(rec.sessionId, models);
  }

  for (const [sessionId, after] of Object.entries(parseOutput.endState.runningTotals)) {
    const before = cursor.runningTotals[sessionId];
    if (
      before &&
      before.inputTokens <= LONG_CONTEXT_THRESHOLD_TOKENS &&
      after.inputTokens > LONG_CONTEXT_THRESHOLD_TOKENS &&
      (modelsBySession.get(sessionId)?.size ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build a FileContribution from normalized records and tool events.
 * Groups by (day, source, variantId, workspace) for daily and by
 * (source, sessionId) for sessions.
 */
function buildContribution(
  records: UsageRecord[],
  toolEvents: ToolEvent[],
  pricing: PricingEngine,
): FileContribution {
  const longContextKeys = sessionModelLongContextKeys(records, pricing);

  // Daily aggregates keyed by "day|source|variantId|workspace"
  const dailyMap = new Map<string, {
    day: string; source: Source; variantId: string; workspace: string;
    sums: TokenSums; turns: number; costUsd: number; unknownTurns: number;
  }>();

  // Session aggregates keyed by "source|sessionId"
  const sessionMap = new Map<string, {
    source: Source; sessionId: string; sums: TokenSums;
    turns: number; costUsd: number;
    firstTsUtc: number; lastTsUtc: number; sidechainTokens: number;
  }>();

  const recordKeys: string[] = [];

  for (const rec of records) {
    // Stored, so stored form: this list is persisted inside the file cursor and
    // is only ever compared for equality against what the database holds.
    recordKeys.push(storageKey(rec.dedupKey));

    const tsDate = new Date(rec.timestamp);
    const day = localDay(tsDate);
    const workspace = rec.workspace ?? "";

    // Cost
    const cost = pricing.costOfAggregate(
      rec.model,
      {
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cacheReadTokens: rec.cacheReadTokens,
        cacheCreationTokens: rec.cacheCreationTokens,
        reasoningTokens: rec.reasoningTokens,
      },
      {
        contextUsedTokens: rec.meta?.contextUsedTokens,
        forceLongContext: longContextKeys.has(sessionModelKey(rec.source, rec.sessionId, rec.model)),
      },
    );

    // Daily
    const dailyKey = `${day}|${rec.source}|${rec.variantId}|${workspace}`;
    const existing = dailyMap.get(dailyKey);
    if (existing) {
      existing.sums.inputTokens += rec.inputTokens;
      existing.sums.outputTokens += rec.outputTokens;
      existing.sums.cacheReadTokens += rec.cacheReadTokens;
      existing.sums.cacheCreationTokens += rec.cacheCreationTokens;
      existing.sums.reasoningTokens += rec.reasoningTokens;
      existing.turns++;
      existing.costUsd += cost.usd;
      if (cost.unknown) { existing.unknownTurns++; }
    } else {
      dailyMap.set(dailyKey, {
        day, source: rec.source, variantId: rec.variantId, workspace,
        sums: {
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheCreationTokens: rec.cacheCreationTokens,
          reasoningTokens: rec.reasoningTokens,
        },
        turns: 1,
        costUsd: cost.usd,
        unknownTurns: cost.unknown ? 1 : 0,
      });
    }

    // Session
    const sessKey = `${rec.source}|${rec.sessionId}`;
    const total = totalTokens(rec);
    const isSidechain = rec.meta?.isSidechain ?? false;
    const existingSess = sessionMap.get(sessKey);
    if (existingSess) {
      existingSess.sums.inputTokens += rec.inputTokens;
      existingSess.sums.outputTokens += rec.outputTokens;
      existingSess.sums.cacheReadTokens += rec.cacheReadTokens;
      existingSess.sums.cacheCreationTokens += rec.cacheCreationTokens;
      existingSess.sums.reasoningTokens += rec.reasoningTokens;
      existingSess.turns++;
      existingSess.costUsd += cost.usd;
      existingSess.firstTsUtc = Math.min(existingSess.firstTsUtc, rec.timestamp);
      existingSess.lastTsUtc = Math.max(existingSess.lastTsUtc, rec.timestamp);
      if (isSidechain) { existingSess.sidechainTokens += total; }
    } else {
      sessionMap.set(sessKey, {
        source: rec.source, sessionId: rec.sessionId,
        sums: {
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheCreationTokens: rec.cacheCreationTokens,
          reasoningTokens: rec.reasoningTokens,
        },
        turns: 1,
        costUsd: cost.usd,
        firstTsUtc: rec.timestamp,
        lastTsUtc: rec.timestamp,
        sidechainTokens: isSidechain ? total : 0,
      });
    }
  }

  return {
    daily: [...dailyMap.values()],
    sessions: [...sessionMap.values()],
    recordKeys,
    toolEventCount: toolEvents.length,
  };
}

function sessionModelLongContextKeys(records: UsageRecord[], pricing: PricingEngine): Set<string> {
  const keys = new Set<string>();
  for (const rec of records) {
    const contextUsed = rec.meta?.contextUsedTokens;
    if (
      contextUsed !== undefined &&
      contextUsed > LONG_CONTEXT_THRESHOLD_TOKENS &&
      pricing.hasLongContextRate(rec.model)
    ) {
      keys.add(sessionModelKey(rec.source, rec.sessionId, rec.model));
    }
  }
  return keys;
}

function sessionModelKey(source: Source, sessionId: string, model: string): string {
  return `${source}\0${sessionId}\0${model}`;
}

/**
 * Merge a previous contribution with a new one (for append mode).
 * Combines daily and session entries additively.
 */
function mergeContributions(prev: FileContribution, next: FileContribution): FileContribution {
  // Merge daily: combine by key
  const dailyMap = new Map<string, FileContribution["daily"][number]>();
  for (const d of prev.daily) {
    const key = `${d.day}|${d.source}|${d.variantId}|${d.workspace}`;
    dailyMap.set(key, { ...d, sums: { ...d.sums } });
  }
  for (const d of next.daily) {
    const key = `${d.day}|${d.source}|${d.variantId}|${d.workspace}`;
    const existing = dailyMap.get(key);
    if (existing) {
      existing.sums.inputTokens += d.sums.inputTokens;
      existing.sums.outputTokens += d.sums.outputTokens;
      existing.sums.cacheReadTokens += d.sums.cacheReadTokens;
      existing.sums.cacheCreationTokens += d.sums.cacheCreationTokens;
      existing.sums.reasoningTokens += d.sums.reasoningTokens;
      existing.turns += d.turns;
      existing.costUsd += d.costUsd;
      existing.unknownTurns += d.unknownTurns;
    } else {
      dailyMap.set(key, { ...d, sums: { ...d.sums } });
    }
  }

  // Merge sessions: combine by key
  const sessMap = new Map<string, FileContribution["sessions"][number]>();
  for (const s of prev.sessions) {
    const key = `${s.source}|${s.sessionId}`;
    sessMap.set(key, { ...s, sums: { ...s.sums } });
  }
  for (const s of next.sessions) {
    const key = `${s.source}|${s.sessionId}`;
    const existing = sessMap.get(key);
    if (existing) {
      existing.sums.inputTokens += s.sums.inputTokens;
      existing.sums.outputTokens += s.sums.outputTokens;
      existing.sums.cacheReadTokens += s.sums.cacheReadTokens;
      existing.sums.cacheCreationTokens += s.sums.cacheCreationTokens;
      existing.sums.reasoningTokens += s.sums.reasoningTokens;
      existing.turns += s.turns;
      existing.costUsd += s.costUsd;
      existing.firstTsUtc = Math.min(existing.firstTsUtc, s.firstTsUtc);
      existing.lastTsUtc = Math.max(existing.lastTsUtc, s.lastTsUtc);
      existing.sidechainTokens += s.sidechainTokens;
    } else {
      sessMap.set(key, { ...s, sums: { ...s.sums } });
    }
  }

  return {
    daily: [...dailyMap.values()],
    sessions: [...sessMap.values()],
    recordKeys: [...prev.recordKeys, ...next.recordKeys],
    toolEventCount: prev.toolEventCount + next.toolEventCount,
  };
}
