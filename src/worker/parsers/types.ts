/**
 * Streaming parse contract for source-specific parsers.
 *
 * Each parser (Codex, Claude) implements `SourceParser` and yields batches of
 * `ParseOutput` via a sink callback. The contract supports incremental/append
 * parsing (Req 4.8), resume state for running totals and dedup (Req 4.11/4.12),
 * and bounded-memory line skipping (Req 4.14).
 *
 * This module MUST NOT import `vscode`.
 */

import type { RawTurn, ToolEvent, CumulativeTotals, Effort } from "../../shared/types.js";

/** Input to a streaming parser invocation. */
export interface ParseInput {
  filePath: string;
  fileId?: string;            // stable stat identity, used to scope file-local offsets
  startOffset: number;       // 0 for full read, lastByteOffset for append (Req 4.8)
  endOffset?: number;        // immutable snapshot boundary captured during discovery
  maxLineBytes: number;      // default 1 MB; skip larger lines unbuffered (Req 4.14)
  resumeState?: ResumeState; // running totals + recent requestIds (Req 4.11/4.12)
  /**
   * Emit a checkpoint batch once this many turns have accumulated, so a single
   * huge session log does not hold every turn and tool event in memory at once.
   * A checkpoint is only taken at a safe line boundary, and its `endOffset` is
   * the start of the not-yet-consumed line, so the caller can commit it and
   * resume exactly there. Undefined means one batch for the whole read.
   */
  checkpointTurns?: number;
}

/**
 * Output batch yielded by a parser via the sink callback.
 *
 * With `checkpointTurns` set, a parse yields several batches; each one is a
 * complete, committable unit ending on a line boundary, and `endState` carries
 * the running state the next batch continues from.
 */
export interface ParseOutput {
  rawTurns: RawTurn[];       // RAW per-turn output; normalizer decomposes → UsageRecord
  toolEvents: ToolEvent[];
  endOffset: number;         // new lastByteOffset
  endState: ResumeState;     // new running totals + recent requestIds
  malformedCount: number;    // unparseable JSON lines skipped (Req 1.8, 15.3a)
  /**
   * Lines past `maxLineBytes` that carried no token data (Req 4.14, 15.3b).
   * Skipping them loses nothing countable.
   */
  oversizedCount: number;
  /**
   * Lines past `maxLineBytes` that carried token data and were parsed anyway.
   * Their numbers ARE included in the totals.
   */
  oversizedRecoveredCount: number;
  /**
   * Lines too large to buffer at all that carried token data. The only counter
   * that means tokens are missing.
   */
  oversizedLostUsageCount: number;
  sessionMeta?: SessionMeta;
}

/** State carried across append boundaries for incremental parsing. */
export interface ResumeState {
  runningTotals: Record<string /*sessionId*/, CumulativeTotals>; // Codex (Req 4.11)
  recentRequestIds: string[];                                     // Claude (Req 4.12)
  codex?: CodexResumeContext;
}

export interface CodexResumeContext {
  sessionId: string;
  model: string;
  effort?: Effort;
  approvalPolicy?: string;
  sandboxMode?: string;
  pendingToolNames: string[];
}

/** Session-level metadata captured from session_meta lines (Codex) or first assistant line (Claude). */
export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  cliVersion?: string;
  gitBranch?: string;
  gitRepoUrl?: string;
  source?: string;           // e.g. "codex_vscode", "cli"
}

/** A source-specific streaming parser. */
export interface SourceParser {
  parse(input: ParseInput, sink: (batch: ParseOutput) => void): Promise<void>;
}
