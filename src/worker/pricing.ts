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
import { FALLBACK_RATE } from "../shared/defaultPricing.js";

export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export interface PricingContext {
  contextUsedTokens?: number;
  forceLongContext?: boolean;
}

export interface CostBreakdown {
  usd: number;
  /** True when the model has no entry in the pricing table (Req 6.3, 7.13). */
  unknown: boolean;
  effectiveModel: string;
  longContextApplied: boolean;
  longContextMissingRate: boolean;
}

export interface LongContextStatus {
  thresholdTokens: number;
  requested: boolean;
  applied: boolean;
  missingRate: boolean;
  effectiveModel: string;
}

export class PricingEngine {
  private readonly table: PricingTable;
  private readonly fallbackRate: ModelRate;

  constructor(table: PricingTable, fallbackRate?: ModelRate) {
    this.table = table;
    this.fallbackRate = fallbackRate ?? FALLBACK_RATE;
  }

  /**
   * Compute cost for a set of cumulative token totals (e.g. from parser resume state).
   */
  costOfTokens(model: string, t: CumulativeTotals, context?: PricingContext): CostBreakdown {
    return this.compute(model, t, context);
  }

  /**
   * Compute cost for aggregate token sums (e.g. from stored daily/session aggregates).
   * Same logic — TokenSums has the same five fields.
   */
  costOfAggregate(model: string, agg: TokenSums, context?: PricingContext): CostBreakdown {
    return this.compute(model, agg, context);
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

  fallbackModelRate(): ModelRate {
    return { ...this.fallbackRate };
  }

  hasLongContextRate(model: string): boolean {
    return Object.hasOwn(this.table, longContextModelId(model));
  }

  longContextStatus(model: string, contextUsedTokens?: number, forceLongContext = false): LongContextStatus {
    const requested = forceLongContext ||
      (contextUsedTokens !== undefined && contextUsedTokens > LONG_CONTEXT_THRESHOLD_TOKENS);
    if (!requested) {
      return {
        thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
        requested: false,
        applied: false,
        missingRate: false,
        effectiveModel: model,
      };
    }

    const effectiveModel = longContextModelId(model);
    const hasRate = Object.hasOwn(this.table, effectiveModel);
    return {
      thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
      requested: true,
      applied: hasRate,
      missingRate: !hasRate,
      effectiveModel: hasRate ? effectiveModel : model,
    };
  }

  private compute(model: string, t: CumulativeTotals | TokenSums, context?: PricingContext): CostBreakdown {
    const longContext = this.longContextStatus(
      model,
      context?.contextUsedTokens,
      context?.forceLongContext,
    );
    const effectiveModel = longContext.effectiveModel;
    let rate: ModelRate | undefined = Object.hasOwn(this.table, effectiveModel) ? this.table[effectiveModel] : undefined;
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

    return {
      usd,
      unknown,
      effectiveModel,
      longContextApplied: longContext.applied,
      longContextMissingRate: longContext.missingRate,
    };
  }
}

function longContextModelId(model: string): string {
  return model.endsWith("-long-context") ? model : `${model}-long-context`;
}
