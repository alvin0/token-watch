import type { Effort } from "../shared/types";
import type { ModelSummaryRow } from "../shared/modelSummary";

/**
 * A summarized model row plus the effort variant the UI shows.
 *
 * The numeric fields come from `summarizeModels` (shared/modelSummary) so the
 * table, the detail row and the summary cards can never disagree.
 */
export type ModelUsageSummary = ModelSummaryRow & { effort?: Effort };

export type ModelSortKey = "tokens" | "cost" | "turns" | "share";
export type SortDirection = "asc" | "desc";

/** Minimal shape `sortModelUsage` needs, so callers can sort any row type. */
export interface SortableModelUsage {
  id: string;
  total: number;
  cost: number;
  turns: number;
  share: number;
}

export function formatEffortLabel(effort?: Effort): string {
  if (!effort || effort === "n/a") { return "N/A"; }
  if (effort === "low") { return "Light"; }
  if (effort === "xhigh") { return "Extra High"; }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function sortModelUsage<T extends SortableModelUsage>(
  models: T[],
  key: ModelSortKey,
  direction: SortDirection,
): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...models].sort((left, right) => {
    const delta = sortValue(left, key) - sortValue(right, key);
    return delta === 0 ? left.id.localeCompare(right.id) : delta * multiplier;
  });
}

function sortValue(model: SortableModelUsage, key: ModelSortKey): number {
  if (key === "tokens") { return model.total; }
  if (key === "cost") { return model.cost; }
  if (key === "turns") { return model.turns; }
  return model.share;
}
