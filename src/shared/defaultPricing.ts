/**
 * Bundled default pricing table (USD per 1K tokens).
 *
 * Models are auto-discovered from logs. Any model not in this table will use
 * a fallback rate based on the model family prefix. Users can override via config.
 */

import type { PricingTable } from "./types.js";

export const DEFAULT_PRICING: PricingTable = {
  // GPT-5 family (Codex)
  "gpt-5": { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 },
  "gpt-5-codex": { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 },
  "gpt-5-codex-mini": { inputPer1K: 0.001, cachedInputPer1K: 0.0005, outputPer1K: 0.004 },
  "gpt-5-mini": { inputPer1K: 0.001, cachedInputPer1K: 0.0005, outputPer1K: 0.004 },
  // GPT-5.1
  "gpt-5.1-codex": { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 },
  "gpt-5.1-codex-max": { inputPer1K: 0.005, cachedInputPer1K: 0.0025, outputPer1K: 0.015 },
  "gpt-5.1-codex-mini": { inputPer1K: 0.001, cachedInputPer1K: 0.0005, outputPer1K: 0.004 },
  // GPT-5.2
  "gpt-5.2": { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 },
  "gpt-5.2-codex": { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 },
  // GPT-5.3
  "gpt-5.3-codex": { inputPer1K: 0.004, cachedInputPer1K: 0.002, outputPer1K: 0.012 },
  "gpt-5.3-codex-spark": { inputPer1K: 0.002, cachedInputPer1K: 0.001, outputPer1K: 0.008 },
  // GPT-5.4
  "gpt-5.4": { inputPer1K: 0.004, cachedInputPer1K: 0.002, outputPer1K: 0.014 },
  "gpt-5.4-mini": { inputPer1K: 0.001, cachedInputPer1K: 0.0005, outputPer1K: 0.005 },
  // GPT-5.5
  "gpt-5.5": { inputPer1K: 0.005, cachedInputPer1K: 0.0025, outputPer1K: 0.015 },
  // Claude
  "claude-sonnet-4-20250514": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-opus-4-20250514": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-opus-4.6": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-opus-4.7": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
};

/**
 * Fallback rate for models not in the pricing table.
 * Uses a conservative mid-range estimate so cost is never $0 for real usage.
 */
export const FALLBACK_RATE = {
  inputPer1K: 0.003,
  cachedInputPer1K: 0.0015,
  outputPer1K: 0.012,
};
