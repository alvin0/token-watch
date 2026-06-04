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
import type { RawClaudeTurn, ToolEvent, TurnMeta } from "../../shared/types";

/** Max recent requestIds to carry in endState for resume boundary detection. */
const MAX_RECENT_IDS = 10;

export class ClaudeParser implements SourceParser {
  async parse(input: ParseInput, sink: (batch: ParseOutput) => void): Promise<void> {
    const { filePath, startOffset, maxLineBytes, resumeState } = input;

    const rawTurns: RawClaudeTurn[] = [];
    const toolEvents: ToolEvent[] = [];
    let malformedCount = 0;
    let sessionMeta: SessionMeta | undefined;

    // Last-wins dedup state
    let currentRequestId: string | null = null;
    let bufferedTurn: RawClaudeTurn | null = null;
    let bufferedTools: ToolEvent[] = [];

    // Recent requestIds for resume boundary detection
    const recentIds: string[] = resumeState?.recentRequestIds?.slice() ?? [];

    // Set of requestIds from resume state for boundary detection
    const resumeIds = new Set(recentIds);

    function flushBuffered() {
      if (bufferedTurn) {
        rawTurns.push(bufferedTurn);
        toolEvents.push(...bufferedTools);
      }
      bufferedTurn = null;
      bufferedTools = [];
    }

    const stats = await readLines({ filePath, startOffset, maxLineBytes }, (line, _byteOffset, isCompleteLine) => {
      // Fast substring check: only parse lines with both "assistant" and "usage"
      if (!line.includes('"assistant"') || !line.includes('"usage"')) {
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (!isCompleteLine) {
          malformedCount++;
          return false;
        }
        malformedCount++;
        return;
      }

      // Must be assistant type with message.usage
      if (parsed.type !== "assistant" || !parsed.message?.usage) {
        return;
      }

      const msg = parsed.message;
      const usage = msg.usage;

      // Skip synthetic/internal responses — not real API usage
      const model: string = msg.model ?? "";
      if (!model || model.startsWith("<") || model === "unknown") {
        return;
      }
      const sessionId: string = parsed.sessionId ?? "";
      const requestId: string = parsed.requestId || parsed.uuid || "";
      const dedupKey = `claude:${sessionId}:${requestId}`;
      const timestamp = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

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
      if (parsed.isSidechain != null) { meta.isSidechain = parsed.isSidechain; }
      if (parsed.entrypoint) { meta.entrypoint = parsed.entrypoint; }
      if (parsed.version) { meta.version = parsed.version; }

      // Build raw turn
      const turn: RawClaudeTurn = {
        source: "claude",
        sessionId,
        timestamp,
        model: msg.model ?? "",
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
        if (currentRequestId === null && resumeIds.has(requestId)) {
          // Continuation from resume — still last-wins, don't flush
          currentRequestId = requestId;
          bufferedTurn = turn;
          bufferedTools = turnTools;
        } else {
          // Genuinely new group — flush previous
          flushBuffered();
          currentRequestId = requestId;
          bufferedTurn = turn;
          bufferedTools = turnTools;
        }
      }

      // Track recent requestIds
      if (!recentIds.includes(requestId)) {
        recentIds.push(requestId);
        if (recentIds.length > MAX_RECENT_IDS) {
          recentIds.shift();
        }
      }
    });

    // Flush last buffered group
    flushBuffered();

    const endState: ResumeState = {
      runningTotals: resumeState?.runningTotals ?? {},
      recentRequestIds: recentIds.slice(-MAX_RECENT_IDS),
    };

    sink({
      rawTurns,
      toolEvents,
      endOffset: stats.endOffset,
      endState,
      malformedCount,
      oversizedCount: stats.oversizedCount,
      sessionMeta,
    });
  }
}
