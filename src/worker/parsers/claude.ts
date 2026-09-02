/**
 * Claude JSONL parser.
 *
 * Streams a Claude session log, emitting one RawClaudeTurn per assistant line
 * with message.usage. Handles last-wins dedup for contiguous repeated requestIds
 * and extracts tool_use blocks as ToolEvents.
 *
 * This module MUST NOT import `vscode`.
 * Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 4.12, 13.1
 */

import { readLines } from "./lineReader";
import type { ParseInput, ParseOutput, ResumeState, SessionMeta, SourceParser } from "./types";
import type { Effort, RawClaudeTurn, ToolEvent, TurnMeta } from "../../shared/types";
import { createHash } from "node:crypto";

/** Max recent requestIds to carry in endState for resume boundary detection. */
const MAX_RECENT_IDS = 10;
const RECENT_REQUEST_SEPARATOR = "\u0000";

/**
 * Substrings that mark a Claude line as carrying token counts.
 *
 * An assistant turn that writes a large file is a single very long line that
 * still carries `message.usage`; dropping it on length alone lost those tokens.
 */
const CLAUDE_USAGE_MARKERS = ['"usage"'] as const;

interface ClaudeLogLine {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
    effort?: unknown;
    output_config?: { effort?: unknown };
    stop_reason?: string;
    content?: Array<{ type?: string; name?: string }>;
  };
  sessionId?: string;
  requestId?: string;
  uuid?: string;
  timestamp?: string | number;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean | null;
  entrypoint?: string;
  effort?: unknown;
  output_config?: { effort?: unknown };
}

export class ClaudeParser implements SourceParser {
  async parse(input: ParseInput, sink: (batch: ParseOutput) => void): Promise<void> {
    const { filePath, fileId, startOffset, endOffset, maxLineBytes, resumeState, checkpointTurns } = input;
    const fileScope = scopedFileId(fileId ?? filePath);

    const rawTurns: RawClaudeTurn[] = [];
    const toolEvents: ToolEvent[] = [];
    let malformedCount = 0;
    let sessionMeta: SessionMeta | undefined;

    // Last-wins dedup state
    let currentRequestId: string | null = null;
    let currentGroupKey: string | null = null;
    let bufferedTurn: RawClaudeTurn | null = null;
    let bufferedTools: ToolEvent[] = [];
    /**
     * Byte offset of the first line of the group currently buffered. A
     * checkpoint may only claim bytes up to here: the buffered group is still
     * open (last-wins dedup can still replace it), so resuming must re-read it.
     */
    let bufferedGroupStartOffset = 0;

    const recentRequests = (resumeState?.recentRequestIds ?? []).map(decodeRecentRequest);
    const resumeLastRequest = recentRequests[recentRequests.length - 1];

    function flushBuffered() {
      if (bufferedTurn) {
        rawTurns.push(bufferedTurn);
        toolEvents.push(...bufferedTools);
      }
      bufferedTurn = null;
      bufferedTools = [];
    }

    function rememberRecentRequest(requestId: string, groupKey: string) {
      const last = recentRequests[recentRequests.length - 1];
      if (last?.requestId === requestId && last.groupKey === groupKey) {
        return;
      }
      recentRequests.push({ requestId, groupKey });
      while (recentRequests.length > MAX_RECENT_IDS) {
        recentRequests.shift();
      }
    }

    const currentResumeState = (): ResumeState => ({
      runningTotals: resumeState?.runningTotals ?? {},
      recentRequestIds: recentRequests.slice(-MAX_RECENT_IDS).map(encodeRecentRequest),
    });

    /**
     * Hand off everything accumulated so far and start a fresh batch.
     * `boundaryOffset` is the first byte NOT covered by the batch.
     */
    const emitCheckpoint = (boundaryOffset: number): void => {
      sink({
        rawTurns: rawTurns.splice(0),
        toolEvents: toolEvents.splice(0),
        endOffset: boundaryOffset,
        endState: currentResumeState(),
        malformedCount,
        oversizedCount: 0,
        oversizedRecoveredCount: 0,
        oversizedLostUsageCount: 0,
        sessionMeta,
      });
      malformedCount = 0;
    };

    const stats = await readLines({ filePath, startOffset, endOffset, maxLineBytes, usageMarkers: CLAUDE_USAGE_MARKERS }, (line, byteOffset, isCompleteLine) => {
      // Checkpoint at the start of the open group, not at this line: the
      // buffered group can still be replaced by a later line with the same
      // requestId, so it is not yet a committable boundary.
      if (checkpointTurns && rawTurns.length >= checkpointTurns) {
        emitCheckpoint(bufferedTurn ? bufferedGroupStartOffset : byteOffset);
      }

      // Fast substring check: only parse lines with both "assistant" and "usage"
      if (!line.includes('"assistant"') || !line.includes('"usage"')) {
        return;
      }

      let parsed: ClaudeLogLine;
      try {
        parsed = JSON.parse(line) as ClaudeLogLine;
      } catch {
        if (!isCompleteLine) {
          // The last line of a session that is being written right now. It is
          // not malformed, it is unfinished: returning false leaves the cursor
          // before it, so the next scan reads it whole. Counting it made any
          // active session permanently report lines it "could not parse".
          return false;
        }
        malformedCount++;
        return;
      }

      const msg = parsed.message;
      const usage = msg?.usage;

      // Must be assistant type with message.usage
      if (parsed.type !== "assistant" || !msg || !usage) {
        return;
      }

      // Skip synthetic/internal responses — not real API usage
      const model: string = msg.model ?? "";
      if (!model || model.startsWith("<") || model === "unknown") {
        return;
      }
      const sessionId: string = parsed.sessionId ?? "";
      const requestId: string = parsed.requestId || parsed.uuid || "";
      const timestamp = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
      const isResumeContinuation =
        currentRequestId === null &&
        resumeLastRequest?.requestId === requestId;
      const groupKey = currentRequestId === requestId
        ? currentGroupKey ?? claudeGroupKey(sessionId, fileScope, requestId, byteOffset)
        : isResumeContinuation
          ? resumeLastRequest.groupKey ?? legacyClaudeGroupKey(sessionId, requestId)
          : claudeGroupKey(sessionId, fileScope, requestId, byteOffset);
      const dedupKey = groupKey;

      // Capture session meta from first assistant line
      if (!sessionMeta && sessionId) {
        sessionMeta = {
          sessionId,
          cwd: parsed.cwd,
          cliVersion: parsed.version,
          gitBranch: parsed.gitBranch,
        };
      }

      // Build meta
      const meta: TurnMeta = {};
      if (msg.stop_reason) { meta.stopReason = msg.stop_reason; }
      if (isPresent(parsed.isSidechain)) { meta.isSidechain = parsed.isSidechain; }
      if (parsed.entrypoint) { meta.entrypoint = parsed.entrypoint; }
      if (parsed.version) { meta.version = parsed.version; }

      // Build raw turn
      const turn: RawClaudeTurn = {
        source: "claude",
        sessionId,
        timestamp,
        model: msg.model ?? "",
        effort: claudeEffort(msg.output_config?.effort ?? msg.effort ?? parsed.output_config?.effort ?? parsed.effort),
        workspace: parsed.cwd || undefined,
        dedupKey,
        meta,
        rawInputTokens: usage.input_tokens ?? 0,
        rawOutputTokens: usage.output_tokens ?? 0,
        rawCacheReadTokens: usage.cache_read_input_tokens ?? 0,
        rawCacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      };

      // Extract tool_use blocks
      const turnTools: ToolEvent[] = [];
      if (Array.isArray(msg.content)) {
        let toolIndex = 0;
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            turnTools.push({
              source: "claude",
              sessionId,
              timestamp,
              toolName: block.name ?? "unknown",
              isSidechain: parsed.isSidechain ?? false,
              recordDedupKey: dedupKey,
              eventKey: `${dedupKey}#${toolIndex}`,
            });
            toolIndex++;
          }
        }
      }

      // Last-wins dedup: same requestId group → replace buffered with latest
      if (requestId === currentRequestId) {
        // Same group — replace (last wins)
        bufferedTurn = turn;
        bufferedTools = turnTools;
      } else {
        // New requestId — check if it's a resume boundary continuation
        if (isResumeContinuation) {
          // Continuation from resume — still last-wins, don't flush
          currentRequestId = requestId;
          currentGroupKey = groupKey;
          bufferedTurn = turn;
          bufferedTools = turnTools;
          bufferedGroupStartOffset = byteOffset;
        } else {
          // Genuinely new group — flush previous
          flushBuffered();
          currentRequestId = requestId;
          currentGroupKey = groupKey;
          bufferedTurn = turn;
          bufferedTools = turnTools;
          bufferedGroupStartOffset = byteOffset;
        }
      }

      rememberRecentRequest(requestId, groupKey);
    });

    // Flush last buffered group
    flushBuffered();

    sink({
      rawTurns,
      toolEvents,
      endOffset: stats.endOffset,
      endState: currentResumeState(),
      malformedCount,
      oversizedCount: stats.oversizedSkippedCount,
      oversizedRecoveredCount: stats.oversizedRecoveredCount,
      oversizedLostUsageCount: stats.oversizedLostUsageCount,
      sessionMeta,
    });
  }
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function claudeEffort(value: unknown): Effort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function scopedFileId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function claudeGroupKey(sessionId: string, fileScope: string, requestId: string, groupStartOffset: number): string {
  return `claude:${sessionId}:${fileScope}:${requestId}:${groupStartOffset}`;
}

function legacyClaudeGroupKey(sessionId: string, requestId: string): string {
  return `claude:${sessionId}:${requestId}`;
}

function encodeRecentRequest(entry: { requestId: string; groupKey?: string }): string {
  return entry.groupKey
    ? `${entry.requestId}${RECENT_REQUEST_SEPARATOR}${entry.groupKey}`
    : entry.requestId;
}

function decodeRecentRequest(value: string): { requestId: string; groupKey?: string } {
  const separatorIndex = value.indexOf(RECENT_REQUEST_SEPARATOR);
  if (separatorIndex < 0) {
    return { requestId: value };
  }
  return {
    requestId: value.slice(0, separatorIndex),
    groupKey: value.slice(separatorIndex + RECENT_REQUEST_SEPARATOR.length),
  };
}
