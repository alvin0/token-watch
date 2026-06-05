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

import type { RawTurn, ToolEvent, CumulativeTotals } from "../../shared/types.js";

/** Input to a streaming parser invocation. */
export interface ParseInput {
  filePath: string;
  fileId?: string;            // stable stat identity, used to scope file-local offsets
  startOffset: number;       // 0 for full read, lastByteOffset for append (Req 4.8)
  maxLineBytes: number;      // default 1 MB; skip larger lines unbuffered (Req 4.14)
  resumeState?: ResumeState; // running totals + recent requestIds (Req 4.11/4.12)
}

/** Output batch yielded by a parser via the sink callback. */
export interface ParseOutput {
  rawTurns: RawTurn[];       // RAW per-turn output; normalizer decomposes → UsageRecord
  toolEvents: ToolEvent[];
  endOffset: number;         // new lastByteOffset
  endState: ResumeState;     // new running totals + recent requestIds
  malformedCount: number;    // unparseable JSON lines skipped (Req 1.8, 15.3a)
  oversizedCount: number;    // lines skipped for exceeding maxLineBytes (Req 4.14, 15.3b)
  sessionMeta?: SessionMeta;
}

/** State carried across append boundaries for incremental parsing. */
export interface ResumeState {
  runningTotals: Record<string /*sessionId*/, CumulativeTotals>; // Codex (Req 4.11)
  recentRequestIds: string[];                                     // Claude (Req 4.12)
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
