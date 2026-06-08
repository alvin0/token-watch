/**
 * Codex JSONL parser.
 *
 * Streams a Codex session log, emitting RawCodexTurns and ToolEvents.
 * This module MUST NOT import `vscode`.
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 13.1, 14.4
 */

import { readLines } from "./lineReader.js";
import type { CodexResumeContext, ParseInput, ParseOutput, ResumeState, SessionMeta, SourceParser } from "./types.js";
import type { RawCodexTurn, ToolEvent, TurnMeta, Effort, CumulativeTotals } from "../../shared/types.js";
import { createHash } from "node:crypto";

const CODEX_RESUME_PREFIX = "codex-context:";

interface CodexTokenUsage {
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  total_tokens?: number | null;
}

interface CodexTokenInfo {
  last_token_usage?: CodexTokenUsage | null;
  total_token_usage?: CodexTokenUsage | null;
  model_context_window?: number | null;
}

interface CodexRateLimits {
  primary?: { used_percent?: number | null };
  secondary?: { used_percent?: number | null };
}

interface CodexLogLine {
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    cli_version?: string;
    source?: string;
    git?: { branch?: string; repository_url?: string };
    model?: string;
    effort?: Effort;
    approval_policy?: string;
    sandbox_policy?: { mode?: string };
    type?: string;
    name?: string;
    info?: CodexTokenInfo;
    rate_limits?: CodexRateLimits;
  };
  info?: CodexTokenInfo;
  timestamp?: string | number;
  rate_limits?: CodexRateLimits;
}

export class CodexParser implements SourceParser {
  async parse(input: ParseInput, sink: (batch: ParseOutput) => void): Promise<void> {
    const { filePath, fileId, startOffset, maxLineBytes, resumeState } = input;
    const fileScope = scopedFileId(fileId ?? filePath);
    const resumeContext = resumeState?.codex ?? decodeCodexResumeContext(resumeState?.recentRequestIds);

    // State
    let currentSessionId = resumeContext?.sessionId || resumeSessionId(resumeState);
    let currentModel = resumeContext?.model ?? "unknown";
    let currentEffort: Effort | undefined = resumeContext?.effort;
    let currentApprovalPolicy: string | undefined = resumeContext?.approvalPolicy;
    let currentSandboxMode: string | undefined = resumeContext?.sandboxMode;
    let pendingToolNames: string[] = resumeContext?.pendingToolNames.slice() ?? [];
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
          parsed = JSON.parse(line) as CodexLogLine;
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

          const dedupKey = `codex:${currentSessionId}:${fileScope}:${byteOffset}`;
          const timestamp = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

          // Determine token usage: prefer last_token_usage, else derive delta
          let inputTokens: number;
          let cachedInputTokens: number;
          let outputTokens: number;
          let reasoningOutputTokens: number;
          let totalTokens: number;

          const last = info.last_token_usage;
          const total = info.total_token_usage;

          if (last && isPresent(last.input_tokens)) {
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
          if (isPresent(info.model_context_window)) {
            meta.contextWindow = info.model_context_window;
          }
          if (isPresent(last?.input_tokens)) {
            meta.contextUsedTokens = last.input_tokens;
          }
          if (currentApprovalPolicy) {
            meta.approvalPolicy = currentApprovalPolicy;
          }
          if (currentSandboxMode) {
            meta.sandboxMode = currentSandboxMode;
          }
          const rateLimits = parsed.rate_limits ?? parsed.payload.rate_limits;
          if (isPresent(rateLimits?.primary?.used_percent)) {
            meta.rateLimitPrimaryPct = rateLimits.primary.used_percent;
          }
          if (isPresent(rateLimits?.secondary?.used_percent)) {
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

    const codexContext = buildCodexResumeContext({
      sessionId: currentSessionId,
      model: currentModel,
      effort: currentEffort,
      approvalPolicy: currentApprovalPolicy,
      sandboxMode: currentSandboxMode,
      pendingToolNames,
    });

    const endState: ResumeState = {
      runningTotals,
      recentRequestIds: [encodeCodexResumeContext(codexContext)],
      codex: codexContext,
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

function scopedFileId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildCodexResumeContext(context: CodexResumeContext): CodexResumeContext {
  return {
    sessionId: context.sessionId,
    model: context.model,
    ...(context.effort ? { effort: context.effort } : {}),
    ...(context.approvalPolicy ? { approvalPolicy: context.approvalPolicy } : {}),
    ...(context.sandboxMode ? { sandboxMode: context.sandboxMode } : {}),
    pendingToolNames: context.pendingToolNames.filter((name) => name.length > 0),
  };
}

function encodeCodexResumeContext(context: CodexResumeContext): string {
  return `${CODEX_RESUME_PREFIX}${JSON.stringify(context)}`;
}

function decodeCodexResumeContext(values: string[] | undefined): CodexResumeContext | undefined {
  const encoded = values?.find((value) => value.startsWith(CODEX_RESUME_PREFIX));
  if (!encoded) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(encoded.slice(CODEX_RESUME_PREFIX.length)) as Partial<CodexResumeContext>;
    if (typeof parsed.sessionId !== "string" || typeof parsed.model !== "string") {
      return undefined;
    }
    return buildCodexResumeContext({
      sessionId: parsed.sessionId,
      model: parsed.model,
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      approvalPolicy: typeof parsed.approvalPolicy === "string" ? parsed.approvalPolicy : undefined,
      sandboxMode: typeof parsed.sandboxMode === "string" ? parsed.sandboxMode : undefined,
      pendingToolNames: Array.isArray(parsed.pendingToolNames)
        ? parsed.pendingToolNames.filter((name): name is string => typeof name === "string")
        : [],
    });
  } catch {
    return undefined;
  }
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
