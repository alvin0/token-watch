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
import type { UsageStore } from "./store/UsageStore";
import type { FileCursor, StoreBatch, FileContribution } from "../shared/storeTypes";
import type { UsageRecord, ToolEvent, Source, TokenSums } from "../shared/types";
import { totalTokens } from "../shared/types";
import { computeHeadHash, computeTailAnchorHash } from "./cursor";
import { CodexParser } from "./parsers/codex";
import { ClaudeParser } from "./parsers/claude";
import { normalize } from "./normalizer";
import { PricingEngine } from "./pricing";
import { localDay } from "../shared/time";
import type { ParseOutput, ResumeState } from "./parsers/types";

export type IngestDecision = "skip" | "append" | "reingest" | "firstRead";

export interface IngestResult {
  processed: number;
  skipped: number;
  appended: number;
  reingested: number;
  firstReads: number;
}

export interface IngestOptions {
  maxLineBytes: number;
  backfillMonths: number;
}

const SMALL_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;
const RECENT_FILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORED_PRIORITY_LIMIT = 500;
const EVENT_LOOP_YIELD_INTERVAL = 25;

/**
 * Pure decision function — no I/O. Determines what action to take for a
 * candidate file given its current cursor state.
 */
export function decideAction(
  candidate: CandidateFile,
  cursor: FileCursor | undefined,
): IngestDecision {
  if (!cursor) {
    return "firstRead";
  }
  if (candidate.fileId !== cursor.fileId) {
    return "reingest";
  }
  if (candidate.size > 0 && isEmptyContribution(cursor.contribution)) {
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
 * Process a single candidate file: decide action, perform I/O (hash checks,
 * parsing), normalize, price, build batch, apply to store, update cursor.
 */
export async function ingestFile(
  candidate: CandidateFile,
  store: UsageStore,
  pricing: PricingEngine,
  options: IngestOptions,
): Promise<FileIngestResult> {
  const empty = (d: IngestDecision): FileIngestResult => ({
    decision: d, malformedCount: 0, oversizedCount: 0,
  });

  const cursor = store.getCursor(candidate.filePath);
  let decision = decideAction(candidate, cursor);

  if (decision === "skip") {
    return empty("skip");
  }

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

  // For append: verify hashes (requires I/O). If they fail → reingest.
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
  const parseForDecision = async (parseDecision: IngestDecision): Promise<ParseOutput | undefined> => {
    const startOffset = parseDecision === "append" && cursor ? cursor.lastByteOffset : 0;
    const resumeState: ResumeState | undefined =
      parseDecision === "append" && cursor
        ? { runningTotals: cursor.runningTotals, recentRequestIds: cursor.recentRequestIds }
        : undefined;

    let output: ParseOutput | undefined;
    await parser.parse(
      {
        filePath: candidate.filePath,
        fileId: candidate.fileId,
        startOffset,
        maxLineBytes: options.maxLineBytes,
        resumeState,
      },
      (batch) => { output = batch; },
    );
    return output;
  };

  let parseOutput = await parseForDecision(decision);

  if (!parseOutput) {
    // No output — still update cursor to reflect current stat
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
      contribution: decision === "append" && cursor ? cursor.contribution : emptyContribution,
    });
    return empty(decision);
  }

  if (parseOutput.endOffset < candidate.size) {
    return empty("skip");
  }

  // Normalize raw turns → UsageRecords
  // Drop turns with no valid timestamp (would land in 1970-01-01 bucket)
  let parsedRecords: UsageRecord[] = parseOutput.rawTurns
    .map(normalize)
    .filter((r) => r.timestamp > 0);
  let parsedToolEvents: ToolEvent[] = parseOutput.toolEvents
    .filter((e) => e.timestamp > 0);
  let { records, toolEvents } = dedupeParsedRecords(parsedRecords, parsedToolEvents);

  if (decision === "append" && cursor && hasOverlappingRecordKeys(cursor.contribution, records)) {
    const reparseOutput = await parseForDecision("reingest");
    if (!reparseOutput || reparseOutput.endOffset < candidate.size) {
      return empty("skip");
    }

    decision = "reingest";
    parseOutput = reparseOutput;
    parsedRecords = parseOutput.rawTurns
      .map(normalize)
      .filter((r) => r.timestamp > 0);
    parsedToolEvents = parseOutput.toolEvents
      .filter((e) => e.timestamp > 0);
    ({ records, toolEvents } = dedupeParsedRecords(parsedRecords, parsedToolEvents));
  }

  // Build contribution (daily + session aggregates)
  const contribution = buildContribution(records, toolEvents, pricing);

  // Merge contribution with existing cursor contribution on append
  const finalContribution = decision === "append" && cursor
    ? mergeContributions(cursor.contribution, contribution)
    : contribution;

  // Build StoreBatch
  const batch: StoreBatch = { records, toolEvents, contribution };

  // Reingest: subtract old contribution only after a successful parse. This
  // keeps the previous good data if an active file ends at a partial JSON line.
  if (decision === "reingest" && cursor) {
    store.subtractFileContribution(cursor.fileId);
    store.deleteFileRows(cursor.fileId);
  }

  // Apply to store
  store.applyFileResult(candidate.fileId, batch);

  // Update cursor
  const headHash = computeHeadHash(candidate.filePath, candidate.size);
  const tailAnchor = computeTailAnchorHash(candidate.filePath, parseOutput.endOffset);
  store.putCursor({
    filePath: candidate.filePath,
    fileId: candidate.fileId,
    source: candidate.source,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    lastByteOffset: parseOutput.endOffset,
    headHash,
    tailAnchorHash: tailAnchor,
    runningTotals: parseOutput.endState.runningTotals,
    recentRequestIds: parseOutput.endState.recentRequestIds,
    contribution: finalContribution,
  });

  return {
    decision,
    malformedCount: parseOutput.malformedCount,
    oversizedCount: parseOutput.oversizedCount,
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
): Promise<IngestResult> {
  const result: IngestResult = {
    processed: 0,
    skipped: 0,
    appended: 0,
    reingested: 0,
    firstReads: 0,
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
    const candidate = ordered[i];
    const fileResult = await ingestFile(candidate, store, pricing, options);
    store.recordFileCatalogIngestResult(candidate, fileResult.decision);
    result.processed++;
    switch (fileResult.decision) {
      case "skip": result.skipped++; break;
      case "append": result.appended++; break;
      case "reingest": result.reingested++; break;
      case "firstRead": result.firstReads++; break;
    }
    totalMalformed += fileResult.malformedCount;
    totalOversized += fileResult.oversizedCount;
    onProgress?.(result.processed, total, fileResult);
    if (result.processed % EVENT_LOOP_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  // Persist quality metrics — incremental appends only see new issues, so we
  // accumulate. forceFull rescans reset these counters beforehand.
  store.updateMetaCounts(totalMalformed, totalOversized);

  // Record last ingest run timestamp
  store.setMeta("last_ingest_run_utc", String(Date.now()));

  // Record unmapped models — evaluate against ALL models in the store, not just
  // those parsed this run, so a watch tick on one file doesn't clobber the set.
  const unmapped = pricing.unmappedModels(store.distinctModels());
  store.recordUnmappedModels(unmapped, pricing.fallbackModelRate());

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
    .map((candidate) => ({
      candidate,
      priorityScore: candidatePriorityScore(candidate, store?.getCursor(candidate.filePath), now),
    }))
    .sort((a, b) =>
      b.priorityScore - a.priorityScore ||
      b.candidate.mtimeMs - a.candidate.mtimeMs ||
      a.candidate.filePath.localeCompare(b.candidate.filePath)
    );
}

export function candidatePriorityScore(
  candidate: CandidateFile,
  cursor: FileCursor | undefined,
  now = Date.now(),
): number {
  const todayStart = startOfLocalDayMs(now);
  const weekStartDay = localDay(new Date(todayStart - 6 * DAY_MS));
  const today = localDay(new Date(now));
  const recentCutoff = now - RECENT_FILE_WINDOW_MS;
  const dayRange = cursor ? dayRangeFromContribution(cursor.contribution) : undefined;
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

function isEmptyContribution(contribution: FileContribution): boolean {
  return contribution.daily.length === 0 &&
    contribution.sessions.length === 0 &&
    contribution.recordKeys.length === 0 &&
    contribution.toolEventCount === 0;
}

function hasOverlappingRecordKeys(contribution: FileContribution, records: UsageRecord[]): boolean {
  if (records.length === 0 || contribution.recordKeys.length === 0) {
    return false;
  }
  const existingKeys = new Set(contribution.recordKeys);
  return records.some((record) => {
    if (existingKeys.has(record.dedupKey)) {
      return true;
    }
    const legacyKey = legacyClaudeRecordKey(record);
    return legacyKey ? existingKeys.has(legacyKey) : false;
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
  oversizedCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
    recordKeys.push(rec.dedupKey);

    const tsDate = new Date(rec.timestamp);
    const day = localDay(tsDate);
    const workspace = rec.workspace ?? "";

    // Cost
    const cost = pricing.costOfAggregate(rec.model, {
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens,
      cacheCreationTokens: rec.cacheCreationTokens,
      reasoningTokens: rec.reasoningTokens,
    });

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
