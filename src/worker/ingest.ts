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

  // Reingest: subtract old contribution, delete old rows (Req 4.10)
  if (decision === "reingest" && cursor) {
    store.subtractFileContribution(cursor.fileId);
    store.deleteFileRows(cursor.fileId);
  }

  // Determine parse start offset and resume state
  const startOffset = decision === "append" && cursor ? cursor.lastByteOffset : 0;
  const resumeState: ResumeState | undefined =
    decision === "append" && cursor
      ? { runningTotals: cursor.runningTotals, recentRequestIds: cursor.recentRequestIds }
      : undefined;

  // Parse
  const parser = candidate.source === "codex" ? new CodexParser() : new ClaudeParser();
  let parseOutput: ParseOutput | undefined;

  await parser.parse(
    { filePath: candidate.filePath, startOffset, maxLineBytes: options.maxLineBytes, resumeState },
    (batch) => { parseOutput = batch; },
  );

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

  // Normalize raw turns → UsageRecords
  // Drop turns with no valid timestamp (would land in 1970-01-01 bucket)
  const records: UsageRecord[] = parseOutput.rawTurns
    .map(normalize)
    .filter((r) => r.timestamp > 0);
  const toolEvents: ToolEvent[] = parseOutput.toolEvents
    .filter((e) => e.timestamp > 0);

  // Build contribution (daily + session aggregates)
  const contribution = buildContribution(records, toolEvents, pricing);

  // Merge contribution with existing cursor contribution on append
  const finalContribution = decision === "append" && cursor
    ? mergeContributions(cursor.contribution, contribution)
    : contribution;

  // Build StoreBatch
  const batch: StoreBatch = { records, toolEvents, contribution };

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
 * Ingest all candidate files with a two-phase strategy for fast time-to-first-data:
 *
 * Phase 1 (fast): Process small files (< 5 MB) first — these are quick to parse
 * and give the user data within seconds. Sorted by mtime desc (most recent first).
 *
 * Phase 2 (background): Process large files (>= 5 MB) after, also mtime desc.
 * These can take minutes for 100+ MB files but the dashboard already has data.
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

  // Two-phase: small files first for fast time-to-first-data
  const SMALL_THRESHOLD = 5 * 1024 * 1024; // 5 MB
  const small = candidates.filter((c) => c.size < SMALL_THRESHOLD);
  const large = candidates.filter((c) => c.size >= SMALL_THRESHOLD);

  const ordered = [...small, ...large];
  const total = ordered.length;

  let totalMalformed = 0;
  let totalOversized = 0;

  for (let i = 0; i < total; i++) {
    const fileResult = await ingestFile(ordered[i], store, pricing, options);
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
  }

  // Persist quality metrics — incremental appends only see new issues, so we
  // accumulate. forceFull rescans reset these counters beforehand.
  store.updateMetaCounts(totalMalformed, totalOversized);

  // Record last ingest run timestamp
  store.setMeta("last_ingest_run_utc", String(Date.now()));

  // Record unmapped models — evaluate against ALL models in the store, not just
  // those parsed this run, so a watch tick on one file doesn't clobber the set.
  const unmapped = pricing.unmappedModels(store.distinctModels());
  store.recordUnmappedModels(unmapped);

  return result;
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
