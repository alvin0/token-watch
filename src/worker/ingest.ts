/**
 * Ingestion driver — decision matrix + file processing pipeline.
 *
 * For each candidate file, decides: skip / append / reingest / firstRead.
 * Then parses, normalizes, prices, and applies the result to the store.
 *
 * This module MUST NOT import `vscode`.
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 4.24, 4.25, 4.26
 */

import { statSync } from "node:fs";
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
import { makeVariantId, baseModelOf } from "../shared/variant";
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
): Promise<IngestDecision> {
  const cursor = store.getCursor(candidate.filePath);
  let decision = decideAction(candidate, cursor);

  if (decision === "skip") {
    return "skip";
  }

  // Backfill cap: on first reads only, skip files older than backfillMonths (Req 4.24)
  if (decision === "firstRead") {
    const cutoff = Date.now() - options.backfillMonths * 30 * 24 * 60 * 60 * 1000;
    if (candidate.mtimeMs < cutoff) {
      return "skip";
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
    return decision;
  }

  // Normalize raw turns → UsageRecords
  const records: UsageRecord[] = parseOutput.rawTurns.map(normalize);
  const toolEvents: ToolEvent[] = parseOutput.toolEvents;

  // Build contribution (daily + session aggregates)
  const contribution = buildContribution(records, toolEvents, pricing, candidate.source);

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

  return decision;
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
  onProgress?: (processed: number, total: number) => void,
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

  for (let i = 0; i < total; i++) {
    const decision = await ingestFile(ordered[i], store, pricing, options);
    result.processed++;
    switch (decision) {
      case "skip": result.skipped++; break;
      case "append": result.appended++; break;
      case "reingest": result.reingested++; break;
      case "firstRead": result.firstReads++; break;
    }
    onProgress?.(result.processed, total);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  source: Source,
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
    const day = toLocalDay(tsDate);
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
      if (cost.unknown) existing.unknownTurns++;
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
      if (isSidechain) existingSess.sidechainTokens += total;
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
