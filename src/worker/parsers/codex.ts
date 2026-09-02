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

/**
 * Substrings that mark a Codex line as carrying token counts.
 *
 * A line matching one of these is parsed even when it is over `maxLineBytes`:
 * length is not evidence that a line is uninteresting, and a dropped
 * `token_count` is a turn missing from every total.
 */
const CODEX_USAGE_MARKERS = ['"token_count"', '"total_token_usage"', '"last_token_usage"'] as const;

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
    const { filePath, fileId, startOffset, endOffset, maxLineBytes, resumeState, checkpointTurns } = input;
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
    /**
     * The last cumulative total seen anywhere in this file.
     *
     * Codex counts cumulatively per rollout file, and the counter runs straight
     * through a change of session id: resuming a session replays its history
     * under the old id and then continues under a new one from the same number.
     * Keying the baseline by session id therefore made the first line after a
     * resume look like a turn that had consumed the entire history — measured at
     * 10.3 billion tokens too many, 39% over, across one real set of logs.
     */
    let fileTotals: CumulativeTotals = latestTotals(runningTotals);

    const rawTurns: RawCodexTurn[] = [];
    const toolEvents: ToolEvent[] = [];
    let malformedCount = 0;
    let sessionMeta: SessionMeta | undefined;

    const currentResumeState = (): ResumeState => {
      const codexContext = buildCodexResumeContext({
        sessionId: currentSessionId,
        model: currentModel,
        effort: currentEffort,
        approvalPolicy: currentApprovalPolicy,
        sandboxMode: currentSandboxMode,
        pendingToolNames,
      });
      return {
        runningTotals: { ...runningTotals },
        recentRequestIds: [encodeCodexResumeContext(codexContext)],
        codex: codexContext,
      };
    };

    /**
     * Hand off everything accumulated so far and start a fresh batch. Called at
     * the START of an unconsumed line, so `endOffset` is a resumable boundary.
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

    const stats = await readLines(
      { filePath, startOffset, endOffset, maxLineBytes, usageMarkers: CODEX_USAGE_MARKERS },
      (line, byteOffset, isCompleteLine) => {
        // A turn's tool events are emitted with the turn, so an empty
        // pendingToolNames means nothing is half-built across the boundary.
        if (checkpointTurns && rawTurns.length >= checkpointTurns && pendingToolNames.length === 0) {
          emitCheckpoint(byteOffset);
        }

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
            // The last line of a session that is being written right now. It is
            // not malformed, it is unfinished: returning false leaves the cursor
            // before it, so the next scan reads it whole. Counting it made any
            // active session permanently report lines it "could not parse".
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

          // Determine token usage from cumulative totals when available. Some
          // Codex logs repeat token_count lines with a non-zero last_token_usage
          // while total_token_usage has not advanced; the cumulative delta is
          // the safer accounting source and still splits by the event timestamp.
          let inputTokens: number;
          let cachedInputTokens: number;
          let outputTokens: number;
          let reasoningOutputTokens: number;
          let totalTokens: number;

          const last = info.last_token_usage;
          const total = info.total_token_usage;

          if (total) {
            const next = totalsFromUsage(total);
            // A counter that has gone backwards was reset — a compaction, or a
            // fresh series in the same file — so what it now reports is usage in
            // full rather than a step up from anything. Dropping the line instead,
            // as this used to, threw those tokens away.
            const restarted = countedTokens(next) < countedTokens(fileTotals);
            const delta = restarted ? next : deltaFromTotal(total, fileTotals);

            runningTotals[currentSessionId] = next;
            fileTotals = next;

            const consumed = countedTokens(delta);
            if (consumed <= 0) {
              pendingToolNames = [];
              return;
            }

            // One component can go backwards while the turn as a whole moved
            // forward. What Codex reports is the total, so hold that fixed and
            // give the slack to whichever side actually rose; clamping each
            // component on its own inflated the total instead.
            inputTokens = Math.min(Math.max(0, delta.inputTokens), consumed);
            outputTokens = consumed - inputTokens;
            // Cached sits inside input and reasoning inside output, so neither can
            // exceed the bucket it belongs to.
            cachedInputTokens = Math.min(Math.max(0, delta.cacheReadTokens), inputTokens);
            reasoningOutputTokens = Math.min(Math.max(0, delta.reasoningTokens), outputTokens);
            totalTokens = consumed;
          } else if (last && isPresent(last.input_tokens)) {
            inputTokens = last.input_tokens;
            cachedInputTokens = last.cached_input_tokens ?? 0;
            outputTokens = last.output_tokens ?? 0;
            reasoningOutputTokens = last.reasoning_output_tokens ?? 0;
            totalTokens = last.total_tokens ?? (inputTokens + outputTokens);
          } else {
            return; // No usable token data
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

/** Tokens a cumulative reading accounts for; cached and reasoning are inside these. */
function countedTokens(totals: CumulativeTotals): number {
  return totals.inputTokens + totals.outputTokens;
}

/**
 * The furthest a file's counter has reached, from whatever a cursor recorded.
 *
 * Older cursors stored one entry per session id seen in the file. The counter
 * is cumulative and monotonic within a file, so the largest of them is where it
 * had got to — which is what resuming the parse needs.
 */
function latestTotals(bySession: Record<string, CumulativeTotals>): CumulativeTotals {
  let best = emptyTotals();
  for (const totals of Object.values(bySession)) {
    if (countedTokens(totals) > countedTokens(best)) { best = totals; }
  }
  return best;
}

function emptyTotals(): CumulativeTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  };
}

function totalsFromUsage(usage: CodexTokenUsage): CumulativeTotals {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? 0,
    cacheCreationTokens: 0,
    reasoningTokens: usage.reasoning_output_tokens ?? 0,
  };
}

function deltaFromTotal(total: CodexTokenUsage, prev: CumulativeTotals): CumulativeTotals {
  return {
    inputTokens: (total.input_tokens ?? 0) - prev.inputTokens,
    outputTokens: (total.output_tokens ?? 0) - prev.outputTokens,
    cacheReadTokens: (total.cached_input_tokens ?? 0) - prev.cacheReadTokens,
    cacheCreationTokens: 0,
    reasoningTokens: (total.reasoning_output_tokens ?? 0) - prev.reasoningTokens,
  };
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
