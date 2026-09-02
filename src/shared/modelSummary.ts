/**
 * Shared model roll-up used by every "top models" surface.
 *
 * Grouping key is `source + variantId`, NOT `variantId` alone: Codex and Claude
 * can expose models with the same id, and merging them would attribute one
 * provider's tokens to the other. Workspace is deliberately NOT part of the key
 * — the same model used from several workspaces is one model.
 *
 * This module MUST NOT import `vscode`.
 */

import type { Source } from "./types";
import type { DailyAggregate } from "./storeTypes";
import { deriveTokenMetrics, type TokenMetrics } from "./tokenMetrics";

export interface ModelSummaryRow {
  /** Stable identity for React keys and selection: `${source}:${variantId}`. */
  id: string;
  source: Source;
  variantId: string;
  baseModel: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead + cacheWrite, for surfaces that show one "cache" column. */
  cache: number;
  reasoning: number;
  total: number;
  turns: number;
  cost: number;
  unknownCostTurns: number;
  /** Number of distinct workspaces this model was used from. */
  workspaces: number;
  /** Percent of the summarized set's tokens. */
  share: number;
  metrics: TokenMetrics;
}

export function modelSummaryKey(source: Source, variantId: string): string {
  return `${source}:${variantId}`;
}

/**
 * Roll `DailyAggregate` rows up per (source, model variant).
 *
 * `rows` should already be filtered to the visible range; `summarizeModels`
 * does no date filtering of its own.
 */
export function summarizeModels(rows: Iterable<DailyAggregate>): ModelSummaryRow[] {
  interface Acc {
    id: string;
    source: Source;
    variantId: string;
    baseModel: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    storedTotal: number;
    turns: number;
    cost: number;
    unknownCostTurns: number;
    workspaces: Set<string>;
  }

  const byModel = new Map<string, Acc>();

  for (const row of rows) {
    const id = modelSummaryKey(row.source, row.variantId);
    let acc = byModel.get(id);
    if (!acc) {
      acc = {
        id,
        source: row.source,
        variantId: row.variantId,
        baseModel: row.baseModel,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        storedTotal: 0,
        turns: 0,
        cost: 0,
        unknownCostTurns: 0,
        workspaces: new Set<string>(),
      };
      byModel.set(id, acc);
    }
    acc.input += row.inputTokens;
    acc.output += row.outputTokens;
    acc.cacheRead += row.cacheReadTokens;
    acc.cacheWrite += row.cacheCreationTokens;
    acc.reasoning += row.reasoningTokens;
    acc.storedTotal += row.totalTokens;
    acc.turns += row.turns;
    acc.cost += row.costUsd;
    acc.unknownCostTurns += row.unknownCostTurns;
    acc.workspaces.add(row.workspace);
  }

  const summaries = [...byModel.values()].map((acc) => {
    const metrics = deriveTokenMetrics({
      inputTokens: acc.input,
      outputTokens: acc.output,
      cacheReadTokens: acc.cacheRead,
      cacheCreationTokens: acc.cacheWrite,
      reasoningTokens: acc.reasoning,
      totalTokens: acc.storedTotal,
    });
    return {
      id: acc.id,
      source: acc.source,
      variantId: acc.variantId,
      baseModel: acc.baseModel,
      input: metrics.input,
      output: metrics.output,
      cacheRead: metrics.cacheRead,
      cacheWrite: metrics.cacheWrite,
      cache: metrics.cacheTotal,
      reasoning: metrics.reasoning,
      total: metrics.total,
      turns: acc.turns,
      cost: acc.cost,
      unknownCostTurns: acc.unknownCostTurns,
      workspaces: acc.workspaces.size,
      share: 0,
      metrics,
    } satisfies ModelSummaryRow;
  });

  const grandTotal = summaries.reduce((sum, model) => sum + model.total, 0);
  for (const model of summaries) {
    model.share = grandTotal > 0 ? (model.total / grandTotal) * 100 : 0;
  }

  return summaries.sort((left, right) => right.total - left.total || left.id.localeCompare(right.id));
}
