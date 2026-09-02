/**
 * Single source of truth for how token counts turn into displayed metrics.
 *
 * Every surface (summary cards, composition bar, model tables, status bar)
 * derives its numbers here so the same five components always add up to the
 * same total and "cache hit" always means the same thing. Cache CREATION is a
 * miss that populates the cache — counting it as a hit inflates the rate and
 * makes a cold cache look warm.
 *
 * This module MUST NOT import `vscode`.
 */

/** The five raw token components a store row carries. */
export interface TokenComponents {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  /** Store-reported total, when the caller has one. */
  totalTokens?: number;
}

export interface TokenMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** cacheRead + cacheWrite — everything that touched the prompt cache. */
  cacheTotal: number;
  /** Sum of the five components. The visible breakdown always adds to this. */
  breakdownTotal: number;
  /** Store-reported total when available, else `breakdownTotal`. */
  total: number;
  /** Prompt tokens: input + cacheRead + cacheWrite. */
  promptTotal: number;
  /** cacheRead / promptTotal × 100 — cache creation counts as a miss. */
  cacheHitPct: number;
}

const EMPTY: TokenComponents = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

export function deriveTokenMetrics(components: Partial<TokenComponents> = EMPTY): TokenMetrics {
  const input = finite(components.inputTokens);
  const output = finite(components.outputTokens);
  const cacheRead = finite(components.cacheReadTokens);
  const cacheWrite = finite(components.cacheCreationTokens);
  const reasoning = finite(components.reasoningTokens);

  const cacheTotal = cacheRead + cacheWrite;
  const breakdownTotal = input + output + cacheTotal + reasoning;
  const promptTotal = input + cacheTotal;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    cacheTotal,
    breakdownTotal,
    total: components.totalTokens === undefined ? breakdownTotal : finite(components.totalTokens),
    promptTotal,
    cacheHitPct: promptTotal > 0 ? (cacheRead / promptTotal) * 100 : 0,
  };
}

/** Component-wise sum, so callers never hand-roll a reduce that drops a field. */
export function sumTokenComponents(rows: Iterable<Partial<TokenComponents>>): TokenComponents {
  const acc: TokenComponents = { ...EMPTY, totalTokens: 0 };
  for (const row of rows) {
    acc.inputTokens += finite(row.inputTokens);
    acc.outputTokens += finite(row.outputTokens);
    acc.cacheReadTokens += finite(row.cacheReadTokens);
    acc.cacheCreationTokens += finite(row.cacheCreationTokens);
    acc.reasoningTokens += finite(row.reasoningTokens);
    acc.totalTokens = finite(acc.totalTokens) + finite(row.totalTokens);
  }
  return acc;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
