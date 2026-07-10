import type { Effort, Source } from "../shared/types";

export interface ModelUsageSummary {
  id: string;
  model: string;
  source: Source;
  effort?: Effort;
  input: number;
  output: number;
  cache: number;
  reasoning: number;
  turns: number;
  cost: number;
  unknownCostTurns: number;
  total: number;
  share: number;
}

export type ModelSortKey = "tokens" | "cost" | "turns" | "share";
export type SortDirection = "asc" | "desc";

export function formatEffortLabel(effort?: Effort): string {
  if (!effort || effort === "n/a") { return "N/A"; }
  if (effort === "low") { return "Light"; }
  if (effort === "xhigh") { return "Extra High"; }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function sortModelUsage(
  models: ModelUsageSummary[],
  key: ModelSortKey,
  direction: SortDirection,
): ModelUsageSummary[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...models].sort((left, right) => {
    const delta = sortValue(left, key) - sortValue(right, key);
    return delta === 0 ? left.id.localeCompare(right.id) : delta * multiplier;
  });
}

function sortValue(model: ModelUsageSummary, key: ModelSortKey): number {
  if (key === "tokens") { return model.total; }
  if (key === "cost") { return model.cost; }
  if (key === "turns") { return model.turns; }
  return model.share;
}
