/**
 * Codex JSONL parser.
 *
 * Streams a Codex session log, emitting RawCodexTurns and ToolEvents.
 * This module MUST NOT import `vscode`.
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 13.1, 14.4
 */

import { readLines } from "./lineReader.js";
import type { ParseInput, ParseOutput, ResumeState, SessionMeta, SourceParser } from "./types.js";
import type { RawCodexTurn, ToolEvent, TurnMeta, Effort, CumulativeTotals } from "../../shared/types.js";

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenInfo {
  last_token_usage?: CodexTokenUsage;
  total_token_usage?: CodexTokenUsage;
  model_context_window?: number;
}

interface CodexRateLimit {
  used_percent?: number;
}

interface CodexRateLimits {
  primary?: CodexRateLimit;
  secondary?: CodexRateLimit;
}

interface CodexPayload {
  id?: string;
  cwd?: string;
  cli_version?: string;
  source?: string;
  git?: {
    branch?: string;
    repository_url?: string;
  };
  model?: string;
  effort?: Effort;
  approval_policy?: string;
  sandbox_policy?: {
    mode?: string;
  };
  type?: string;
  name?: string;
  info?: CodexTokenInfo;
  rate_limits?: CodexRateLimits;
}

interface CodexLogLine {
  type?: string;
  payload?: CodexPayload;
  info?: CodexTokenInfo;
  timestamp?: string;
  rate_limits?: CodexRateLimits;
}

export class CodexParser implements SourceParser {
  async parse(input: ParseInput, sink: (batch: ParseOutput) => void): Promise<void> {
    const { filePath, startOffset, maxLineBytes, resumeState } = input;

    // State
    let currentSessionId = resumeSessionId(resumeState);
    let currentModel = "unknown";
    let currentEffort: Effort | undefined;
    let currentApprovalPolicy: string | undefined;
    let currentSandboxMode: string | undefined;
    let pendingToolNames: string[] = [];
    const runningTotals: Record<string, CumulativeTotals> = resumeState?.runningTotals
      ? { ...resumeState.runningTotals }
      : {};

    const rawTurns: RawCodexTurn[] = [];
    const toolEvents: ToolEvent[] = [];
    let malformedCount = 0;
    let sessionMeta: SessionMeta | undefined;

    const stats = await readLines(
      { filePath, startOffset, maxLineBytes },
      (line, byteOffset, isCompleteLine) => {
        // Fast substring check — only parse lines containing relevant keywords
        if (
          !line.includes('"session_meta"') &&
          !line.includes('"turn_context"') &&
          !line.includes('"token_count"') &&
          !line.includes('"function_call"') &&
          !line.includes('"image_generation_call"')
        ) {
          return;
        }

        let parsed: CodexLogLine;
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

        const type: string | undefined = parsed.type;

        if (type === "session_meta") {
          const payload = parsed.payload;
          if (payload?.id) {
            currentSessionId = payload.id;
            sessionMeta = {
              sessionId: payload.id,
              cwd: payload.cwd,
              cliVersion: payload.cli_version,
              source: payload.source,
              gitBranch: payload.git?.branch,
              gitRepoUrl: payload.git?.repository_url,
            };
          }
          return;
        }

        if (type === "turn_context") {
          const payload = parsed.payload;
          if (payload) {
            currentModel = payload.model ?? currentModel;
            currentEffort = payload.effort as Effort | undefined;
            currentApprovalPolicy = payload.approval_policy;
            currentSandboxMode = payload.sandbox_policy?.mode;
          }
          return;
        }

        if (type === "response_item" && parsed.payload?.type === "function_call") {
          const name = parsed.payload.name;
          if (name) {
            pendingToolNames.push(name);
          }
          return;
        }

        if (type === "response_item" && parsed.payload?.type === "image_generation_call") {
          pendingToolNames.push("image_generation");
          return;
        }

        if (type === "event_msg" && parsed.payload?.type === "token_count") {
          const info = parsed.info ?? parsed.payload.info;
          if (!info) { return; }

          // Skip turns with no model context or zero tokens (empty/compacted sessions)
          if (currentModel === "unknown") { return; }

          const dedupKey = `codex:${currentSessionId}:${byteOffset}`;
          const timestamp = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

          // Determine token usage: prefer last_token_usage, else derive delta
          let inputTokens: number;
          let cachedInputTokens: number;
          let outputTokens: number;
          let reasoningOutputTokens: number;
          let totalTokens: number;

          const last = info.last_token_usage;
          const total = info.total_token_usage;

          if (last && last.input_tokens !== null && last.input_tokens !== undefined) {
            inputTokens = last.input_tokens;
            cachedInputTokens = last.cached_input_tokens ?? 0;
            outputTokens = last.output_tokens ?? 0;
            reasoningOutputTokens = last.reasoning_output_tokens ?? 0;
            totalTokens = last.total_tokens ?? (inputTokens + outputTokens);
          } else if (total) {
            // Derive delta from running totals
            const prev = runningTotals[currentSessionId] ?? {
              inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
            };
            inputTokens = (total.input_tokens ?? 0) - prev.inputTokens;
            cachedInputTokens = (total.cached_input_tokens ?? 0) - prev.cacheReadTokens;
            outputTokens = (total.output_tokens ?? 0) - prev.outputTokens;
            reasoningOutputTokens = (total.reasoning_output_tokens ?? 0) - prev.reasoningTokens;
            totalTokens = (total.total_tokens ?? 0) - (prev.inputTokens + prev.outputTokens);
          } else {
            return; // No usable token data
          }

          // Update running totals from total_token_usage
          if (total) {
            runningTotals[currentSessionId] = {
              inputTokens: total.input_tokens ?? 0,
              outputTokens: total.output_tokens ?? 0,
              cacheReadTokens: total.cached_input_tokens ?? 0,
              cacheCreationTokens: 0, // Codex doesn't report cache creation separately
              reasoningTokens: total.reasoning_output_tokens ?? 0,
            };
          }

          // Build TurnMeta
          const meta: TurnMeta = {};
          if (info.model_context_window !== null && info.model_context_window !== undefined) {
            meta.contextWindow = info.model_context_window;
          }
          if (last?.input_tokens !== null && last?.input_tokens !== undefined) {
            meta.contextUsedTokens = last.input_tokens;
          }
          if (currentApprovalPolicy) {
            meta.approvalPolicy = currentApprovalPolicy;
          }
          if (currentSandboxMode) {
            meta.sandboxMode = currentSandboxMode;
          }
          const rateLimits = parsed.rate_limits ?? parsed.payload.rate_limits;
          if (rateLimits?.primary?.used_percent !== null && rateLimits?.primary?.used_percent !== undefined) {
            meta.rateLimitPrimaryPct = rateLimits.primary.used_percent;
          }
          if (rateLimits?.secondary?.used_percent !== null && rateLimits?.secondary?.used_percent !== undefined) {
            meta.rateLimitSecondaryPct = rateLimits.secondary.used_percent;
          }

          const turn: RawCodexTurn = {
            source: "codex",
            sessionId: currentSessionId,
            timestamp,
            model: currentModel,
            effort: currentEffort,
            dedupKey,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
            rawInputTokens: inputTokens,
            rawCachedInputTokens: cachedInputTokens,
            rawOutputTokens: outputTokens,
            rawReasoningOutputTokens: reasoningOutputTokens,
            rawTotalTokens: totalTokens,
          };
          rawTurns.push(turn);

          // Emit buffered tool events
          for (let i = 0; i < pendingToolNames.length; i++) {
            toolEvents.push({
              source: "codex",
              sessionId: currentSessionId,
              timestamp,
              toolName: pendingToolNames[i],
              isSidechain: false,
              recordDedupKey: dedupKey,
              eventKey: `${dedupKey}#${i}`,
            });
          }
          pendingToolNames = [];
        }
      },
    );

    // Discard any unflushed pendingToolNames (per spec)

    const endState: ResumeState = {
      runningTotals,
      recentRequestIds: resumeState?.recentRequestIds ?? [],
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

function resumeSessionId(resumeState: ResumeState | undefined): string {
  const ids = Object.keys(resumeState?.runningTotals ?? {});
  return ids.length === 1 ? ids[0] : "";
}
