/**
 * Shared domain types for Token Watch.
 *
 * A single module imported by host, worker, and WebView so the message protocol
 * and domain types stay in lockstep. This module MUST NOT import `vscode`.
 */

export type Source = "codex" | "claude";

export type Effort =
  | "minimal" | "low" | "medium" | "high" | "xhigh" | "n/a";

/**
 * The five disjoint token buckets shared by cumulative running totals (parser
 * resume state) and aggregate sums. Kept as a standalone shape so both
 * `CumulativeTotals` and `TokenSums` describe the same five-bucket structure.
 */

/** Cumulative per-session token totals (used by parser resume state, Req 4.11). */
export interface CumulativeTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * The same five-bucket token shape used for stored/aggregated sums (used by the
 * pricing engine `costOfAggregate` and the store aggregate rows). Structurally
 * identical to `CumulativeTotals`, kept as a separate named type because the
 * design references both in different roles.
 */
export interface TokenSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/** The unified, normalized per-turn usage measurement (Req 3.1). */
export interface UsageRecord {
  source: Source;
  sessionId: string;
  /**
   * Idempotency / replacement key. Scoped per session (a requestId is only
   * promised unique within a contiguous group, not globally — Req 2.8):
   *   Claude:  `${source}:${sessionId}:${requestId}`  (fallback when no
   *            requestId: `${source}:${sessionId}:${uuid}`)
   *   Codex:   `${source}:${sessionId}:${lineByteOffset}` (each token_count line
   *            is a distinct turn; offset is stable within a file)
   * The store upserts (REPLACES) by this key, so a later streamed update for the
   * same request overwrites the earlier provisional row instead of adding to it.
   */
  dedupKey: string;
  timestamp: number;        // UTC epoch ms (Req 3.7)
  model: string;            // base model id, e.g. "gpt-5-codex", "claude-opus-4.7"
  effort?: Effort;          // Codex only; undefined/"n/a" for Claude (Req 3.6)
  variantId: string;        // `${model} (${effort})` or `${model}` when no effort (Req 7.1/7.2)
  workspace?: string;       // coarse workspace/repo identifier (Req 12.1)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  /**
   * Per-turn structural metadata, carried ON the record (NOT in a session-keyed
   * map) so multi-turn sessions don't overwrite each other (Req 1.7, 2.7, 14).
   * Persisted into the matching columns of `usage_record`.
   */
  meta?: TurnMeta;
}

/** Documented total (Req 3.3). */
export function totalTokens(r: UsageRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens
       + r.cacheCreationTokens + r.reasoningTokens;
}

/** A tool invocation observed in a turn (Req 13). Counted independently of tokens. */
export interface ToolEvent {
  source: Source;
  sessionId: string;
  timestamp: number;        // UTC epoch ms
  toolName: string;         // e.g. "shell", "update_plan", "Read", "Edit"
  isSidechain: boolean;     // Claude sub-agent turn (Req 13.3)
  /**
   * Link back to the owning turn's `UsageRecord.dedupKey` so tool events are
   * (a) replaced together with the record on last-wins/resume, and (b) joinable
   * to the record's model/effort/workspace for filtered tool charts (Req 13.1).
   * `eventKey = `${recordDedupKey}#${toolIndexInTurn}`` is the unique per-event
   * id used for replace-by-record in the store.
   */
  recordDedupKey: string;
  eventKey: string;
}

/** Per-turn analytics extras, embedded on each UsageRecord.meta (Req 1.7, 2.7, 14). */
export interface TurnMeta {
  stopReason?: string;          // Claude (Req 13.4)
  isSidechain?: boolean;        // Claude (Req 13.3)
  contextWindow?: number;       // Codex info.model_context_window (Req 14.1)
  contextUsedTokens?: number;   // Codex last_token_usage.input_tokens = prompt context at this turn (Req 14.1)
  approvalPolicy?: string;      // Codex (Req 1.7)
  sandboxMode?: string;         // Codex (Req 1.7)
  entrypoint?: string;          // Claude (Req 2.7)
  version?: string;             // Claude version / Codex cli_version
  rateLimitPrimaryPct?: number;   // Codex rate_limits.primary.used_percent (Req 14.4, informational)
  rateLimitSecondaryPct?: number; // Codex rate_limits.secondary.used_percent (Req 14.4)
}

/**
 * Raw, per-turn output of a parser BEFORE token decomposition. The parser owns
 * log-structure concerns (which session/model/effort/workspace/timestamp a turn
 * belongs to, its dedupKey and structural meta) but emits the RAW token fields
 * exactly as they appear in the log. The Normalizer (and only the Normalizer)
 * performs the disjoint-bucket decomposition and returns a `UsageRecord`.
 * This resolves the parser↔normalizer contract: parsers produce RawTurn,
 * `normalize*` consumes RawTurn → UsageRecord (Req 3.4/3.5, Property 18).
 */
export interface RawTurnCommon {
  source: Source;
  sessionId: string;
  timestamp: number;       // UTC epoch ms
  model: string;
  effort?: Effort;
  workspace?: string;
  dedupKey: string;
  meta?: TurnMeta;
}
/** Codex raw token fields (OVERLAPPING: cached ⊆ input, reasoning ⊆ output). */
export interface RawCodexTurn extends RawTurnCommon {
  source: "codex";
  rawInputTokens: number;          // info.*.input_tokens
  rawCachedInputTokens: number;    // info.*.cached_input_tokens (subset of input)
  rawOutputTokens: number;         // info.*.output_tokens
  rawReasoningOutputTokens: number;// info.*.reasoning_output_tokens (subset of output)
  rawTotalTokens: number;          // info.*.total_tokens (== input + output)
}
/** Claude raw token fields (already DISJOINT buckets). */
export interface RawClaudeTurn extends RawTurnCommon {
  source: "claude";
  rawInputTokens: number;            // message.usage.input_tokens (excludes cache)
  rawOutputTokens: number;           // message.usage.output_tokens
  rawCacheReadTokens: number;        // cache_read_input_tokens
  rawCacheCreationTokens: number;    // cache_creation_input_tokens
}
export type RawTurn = RawCodexTurn | RawClaudeTurn;

/**
 * Per-model pricing rates (USD per 1K tokens, per bucket). All fields optional so
 * a partial override only adjusts the buckets it specifies; absent buckets fall
 * back to bundled defaults (Req 6.4, 10.3). A model with no resolvable rate yields
 * an "unknown cost" turn rather than a wrong cost.
 *
 * Defined here (the shared module) so both the protocol and the worker pricing
 * engine reference one source of truth without a shared→worker forward import.
 */
export interface ModelRate {
  inputPer1K?: number;
  cachedInputPer1K?: number;
  cacheCreationPer1K?: number;
  outputPer1K?: number;
}

/** Map of base model id → its rates. Bundled defaults merged with user overrides. */
export type PricingTable = Record<string, ModelRate>;
