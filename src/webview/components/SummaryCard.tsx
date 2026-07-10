import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost, formatCostPerTurn } from "../format";
import { computePeriods, fmtT, pRange } from "../lib/periodData";
import { UsageOverviewCard } from "./UsageOverviewCard";
import type { Period } from "../lib/periodData";

export function SummaryCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, prev } = computePeriods(result.series, g);
  const range = pRange(g);
  const cachingTokens = result.series.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.cacheReadTokens + row.cacheCreationTokens;
  }, 0);
  const toolCalls = result.toolCallsByDay.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.count;
  }, 0);
  const delta = prev.cost > 0 ? ((cur.cost - prev.cost) / prev.cost) * 100 : cur.cost > 0 ? 100 : 0;
  const cacheInputBase = cachingTokens + cur.input;
  const cacheHitPct = cacheInputBase > 0 ? (cachingTokens / cacheInputBase) * 100 : 0;
  const costPerTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";
  const labels: Record<Period, string> = {
    today: `Today cost${sourceLabel}`,
    day: `Last 7 days cost${sourceLabel}`,
    week: `Last 7 weeks cost${sourceLabel}`,
    month: `Last 6 months cost${sourceLabel}`,
    year: `Last 2 years cost${sourceLabel}`,
  };
  const vs: Record<Period, string> = {
    today: "yesterday",
    day: "previous 7 days",
    week: "previous 7 weeks",
    month: "previous 6 months",
    year: "previous 2 years",
  };

  return (
    <UsageOverviewCard
      title={labels[g]}
      cost={formatCost(cur.cost)}
      comparisonCost={formatCost(prev.cost)}
      delta={delta}
      comparisonLabel={vs[g]}
      totalTokens={fmtT(cur.tokens)}
      cachedTokens={fmtT(cachingTokens)}
      inputTokens={fmtT(cur.input)}
      outputTokens={fmtT(cur.output)}
      cacheHitPct={cacheHitPct}
      turns={cur.turns.toLocaleString()}
      toolCalls={toolCalls.toLocaleString()}
      models={cur.models.toLocaleString()}
      costPerTurn={formatCostPerTurn(costPerTurn)}
    />
  );
}
