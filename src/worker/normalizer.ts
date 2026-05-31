/**
 * Normalizer: RawTurn → UsageRecord (Req 3.4, 3.5, 3.6, 3.7).
 *
 * Parsers emit raw, overlapping token fields. This module performs the
 * disjoint-bucket decomposition so downstream code always sees five
 * non-overlapping buckets that sum to the documented total.
 *
 * This module MUST NOT import `vscode`.
 */

import type { RawCodexTurn, RawClaudeTurn, RawTurn, UsageRecord } from "../shared/types";
import { makeVariantId } from "../shared/variant";

export function normalizeCodexTurn(raw: RawCodexTurn): UsageRecord {
  // Disjoint-bucket decomposition (Req 3.4):
  // Codex fields OVERLAP: cached ⊆ input, reasoning ⊆ output
  const cacheReadTokens = raw.rawCachedInputTokens;
  const inputTokens = Math.max(0, raw.rawInputTokens - raw.rawCachedInputTokens);
  const reasoningTokens = raw.rawReasoningOutputTokens;
  const outputTokens = Math.max(0, raw.rawOutputTokens - raw.rawReasoningOutputTokens);
  const cacheCreationTokens = 0; // Codex has no separate cache-creation field

  return {
    source: "codex",
    sessionId: raw.sessionId,
    dedupKey: raw.dedupKey,
    timestamp: raw.timestamp,
    model: raw.model,
    effort: raw.effort,
    variantId: makeVariantId(raw.model, raw.effort),
    workspace: raw.workspace,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    meta: raw.meta,
  };
}

export function normalizeClaudeTurn(raw: RawClaudeTurn): UsageRecord {
  // Claude fields are already disjoint (Req 3.5)
  return {
    source: "claude",
    sessionId: raw.sessionId,
    dedupKey: raw.dedupKey,
    timestamp: raw.timestamp,
    model: raw.model,
    effort: undefined, // Claude has no effort dimension (Req 3.6)
    variantId: makeVariantId(raw.model, undefined),
    workspace: raw.workspace,
    inputTokens: raw.rawInputTokens,
    outputTokens: raw.rawOutputTokens,
    cacheReadTokens: raw.rawCacheReadTokens,
    cacheCreationTokens: raw.rawCacheCreationTokens,
    reasoningTokens: 0, // Claude has no separate reasoning-token field (Req 3.6)
    meta: raw.meta,
  };
}

export function normalize(raw: RawTurn): UsageRecord {
  return raw.source === "codex"
    ? normalizeCodexTurn(raw)
    : normalizeClaudeTurn(raw);
}
