/**
 * Pricing engine — computes USD cost from token sums and a pricing table.
 *
 * Reasoning tokens are billed at the model's output rate (documented assumption).
 * If a model has no entry in the table, cost is 0 and `unknown` is flagged.
 * Missing individual rates within a ModelRate are treated as 0 for that bucket.
 *
 * This module MUST NOT import `vscode`.
 */

import type { ModelRate, PricingTable, CumulativeTotals, TokenSums } from "../shared/types.js";

export interface CostBreakdown {
  usd: number;
  /** True when the model has no entry in the pricing table (Req 6.3, 7.13). */
  unknown: boolean;
}

export class PricingEngine {
  private readonly table: PricingTable;
  private readonly fallbackRate: ModelRate;

  constructor(table: PricingTable, fallbackRate?: ModelRate) {
    this.table = table;
    this.fallbackRate = fallbackRate ?? { inputPer1K: 0.003, cachedInputPer1K: 0.0015, outputPer1K: 0.012 };
  }

  /**
   * Compute cost for a set of cumulative token totals (e.g. from parser resume state).
   */
  costOfTokens(model: string, t: CumulativeTotals): CostBreakdown {
    return this.compute(model, t);
  }

  /**
   * Compute cost for aggregate token sums (e.g. from stored daily/session aggregates).
   * Same logic — TokenSums has the same five fields.
   */
  costOfAggregate(model: string, agg: TokenSums): CostBreakdown {
    return this.compute(model, agg);
  }

  /**
   * Return models from `seen` that have no entry in the pricing table (Req 15.2).
   */
  unmappedModels(seen: Set<string>): string[] {
    const result: string[] = [];
    for (const model of seen) {
      if (!Object.hasOwn(this.table, model)) {
        result.push(model);
      }
    }
    return result;
  }

  private compute(model: string, t: CumulativeTotals | TokenSums): CostBreakdown {
    let rate: ModelRate | undefined = Object.hasOwn(this.table, model) ? this.table[model] : undefined;
    let unknown = false;

    if (!rate) {
      // Use fallback rate — still compute cost so it's never $0 for real usage
      rate = this.fallbackRate;
      unknown = true;
    }

    const usd =
      (t.inputTokens / 1000) * (rate.inputPer1K ?? 0) +
      (t.cacheReadTokens / 1000) * (rate.cachedInputPer1K ?? 0) +
      (t.cacheCreationTokens / 1000) * (rate.cacheCreationPer1K ?? 0) +
      (t.outputTokens / 1000) * (rate.outputPer1K ?? 0) +
      // Reasoning tokens billed at output rate (documented assumption)
      (t.reasoningTokens / 1000) * (rate.outputPer1K ?? 0);

    return { usd, unknown };
  }
}
