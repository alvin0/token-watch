/**
 * Bundled default pricing table (USD per 1K tokens).
 *
 * Models are auto-discovered from logs. Any model not in this table will use
 * the bundled fallback rate. Config files may add custom models, but bundled
 * pricing wins for known model ids.
 */

import type { PricingTable } from "./types.js";

export const DEFAULT_PRICING: PricingTable = {
  // GPT-5 family (Codex)
  "gpt-5": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5-codex": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5-codex-mini": { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 },
  "gpt-5-mini": { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 },
  "gpt-5-nano": { inputPer1K: 0.00005, cachedInputPer1K: 0.000005, outputPer1K: 0.0004 },
  "gpt-5-chat-latest": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5-pro": { inputPer1K: 0.015, cachedInputPer1K: 0, outputPer1K: 0.12 },
  // GPT-5.1
  "gpt-5.1": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-chat-latest": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-codex": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-codex-max": { inputPer1K: 0.00125, cachedInputPer1K: 0.000125, outputPer1K: 0.01 },
  "gpt-5.1-codex-mini": { inputPer1K: 0.00025, cachedInputPer1K: 0.000025, outputPer1K: 0.002 },
  // GPT-5.2
  "gpt-5.2": { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "gpt-5.2-chat-latest": { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "gpt-5.2-codex": { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "gpt-5.2-pro": { inputPer1K: 0.021, cachedInputPer1K: 0, outputPer1K: 0.168 },
  // GPT-5.3
  "gpt-5.3-chat-latest": { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "gpt-5.3-codex": { inputPer1K: 0.00175, cachedInputPer1K: 0.000175, outputPer1K: 0.014 },
  "gpt-5.3-codex-spark": { inputPer1K: 0.002, cachedInputPer1K: 0.001, outputPer1K: 0.008 },
  // GPT-5.4
  "gpt-5.4": { inputPer1K: 0.0025, cachedInputPer1K: 0.00025, outputPer1K: 0.015 },
  "gpt-5.4-2026-03-05": { inputPer1K: 0.0025, cachedInputPer1K: 0.00025, outputPer1K: 0.015 },
  "gpt-5.4-long-context": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.0225 },
  "gpt-5.4-2026-03-05-long-context": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.0225 },
  "gpt-5.4-mini": { inputPer1K: 0.00075, cachedInputPer1K: 0.000075, outputPer1K: 0.0045 },
  "gpt-5.4-mini-2026-03-17": { inputPer1K: 0.00075, cachedInputPer1K: 0.000075, outputPer1K: 0.0045 },
  "gpt-5.4-pro": { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 },
  "gpt-5.4-pro-2026-03-05": { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 },
  "gpt-5.4-pro-long-context": { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 },
  "gpt-5.4-pro-2026-03-05-long-context": { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 },
  // GPT-5.5
  "gpt-5.5": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.03 },
  "gpt-5.5-2026-04-23": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, outputPer1K: 0.03 },
  "gpt-5.5-long-context": { inputPer1K: 0.01, cachedInputPer1K: 0.001, outputPer1K: 0.045 },
  "gpt-5.5-2026-04-23-long-context": { inputPer1K: 0.01, cachedInputPer1K: 0.001, outputPer1K: 0.045 },
  "gpt-5.5-pro": { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 },
  "gpt-5.5-pro-2026-04-23": { inputPer1K: 0.03, cachedInputPer1K: 0, outputPer1K: 0.18 },
  "gpt-5.5-pro-long-context": { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 },
  "gpt-5.5-pro-2026-04-23-long-context": { inputPer1K: 0.06, cachedInputPer1K: 0, outputPer1K: 0.27 },
  // GPT-4 / o-series
  "gpt-4.1": { inputPer1K: 0.002, cachedInputPer1K: 0.0005, outputPer1K: 0.008 },
  "gpt-4.1-mini": { inputPer1K: 0.0004, cachedInputPer1K: 0.0001, outputPer1K: 0.0016 },
  "gpt-4.1-nano": { inputPer1K: 0.0001, cachedInputPer1K: 0.000025, outputPer1K: 0.0004 },
  "gpt-4o": { inputPer1K: 0.0025, cachedInputPer1K: 0.00125, outputPer1K: 0.01 },
  "gpt-4o-mini": { inputPer1K: 0.00015, cachedInputPer1K: 0.000075, outputPer1K: 0.0006 },
  "o3": { inputPer1K: 0.002, cachedInputPer1K: 0.0005, outputPer1K: 0.008 },
  "o3-mini": { inputPer1K: 0.0011, cachedInputPer1K: 0.00055, outputPer1K: 0.0044 },
  "o4-mini": { inputPer1K: 0.0011, cachedInputPer1K: 0.000275, outputPer1K: 0.0044 },
  "codex-mini-latest": { inputPer1K: 0.0015, cachedInputPer1K: 0.000375, outputPer1K: 0.006 },
  // Claude (cacheCreationPer1K uses Anthropic's 5m cache write price)
  "claude-opus-4.8": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4-8": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4.7": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4-7": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4.6": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4-6": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4.5": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4-5": { inputPer1K: 0.005, cachedInputPer1K: 0.0005, cacheCreationPer1K: 0.00625, outputPer1K: 0.025 },
  "claude-opus-4.1": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-opus-4-1": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-opus-4": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-opus-4-20250514": { inputPer1K: 0.015, cachedInputPer1K: 0.0015, cacheCreationPer1K: 0.01875, outputPer1K: 0.075 },
  "claude-sonnet-4.6": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-sonnet-4-6": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-sonnet-4.5": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-sonnet-4-5": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-sonnet-4": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-sonnet-4-20250514": { inputPer1K: 0.003, cachedInputPer1K: 0.0003, cacheCreationPer1K: 0.00375, outputPer1K: 0.015 },
  "claude-haiku-4.5": { inputPer1K: 0.001, cachedInputPer1K: 0.0001, cacheCreationPer1K: 0.00125, outputPer1K: 0.005 },
  "claude-haiku-4-5": { inputPer1K: 0.001, cachedInputPer1K: 0.0001, cacheCreationPer1K: 0.00125, outputPer1K: 0.005 },
  "claude-haiku-3.5": { inputPer1K: 0.0008, cachedInputPer1K: 0.00008, cacheCreationPer1K: 0.001, outputPer1K: 0.004 },
  "claude-haiku-3-5": { inputPer1K: 0.0008, cachedInputPer1K: 0.00008, cacheCreationPer1K: 0.001, outputPer1K: 0.004 },
  "claude-3-5-haiku-20241022": { inputPer1K: 0.0008, cachedInputPer1K: 0.00008, cacheCreationPer1K: 0.001, outputPer1K: 0.004 },
};

/**
 * Fallback rate for models not in the pricing table.
 * Uses the base GPT-5 rate so cost is never $0 for real usage.
 */
export const FALLBACK_RATE = {
  inputPer1K: 0.00125,
  cachedInputPer1K: 0.000125,
  outputPer1K: 0.01,
};
