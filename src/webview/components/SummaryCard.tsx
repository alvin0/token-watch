import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
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
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";
  const labels: Record<Period, string> = {
    today: `Today cost${sourceLabel}`,
    day: `Last 7 days cost${sourceLabel}`,
    week: `Last 7 weeks cost${sourceLabel}`,
    month: `Last 6 months cost${sourceLabel}`,
    year: `Last 2 years cost${sourceLabel}`,
  };
  const vs: Record<Period, string> = {
    today: "vs yesterday",
    day: "vs previous 7 days",
    week: "vs previous 7 weeks",
    month: "vs previous 6 months",
    year: "vs previous 2 years",
  };

  return (
    <UsageOverviewCard
      title={labels[g]}
      cost={formatCost(cur.cost)}
      delta={delta}
      deltaLabel={vs[g]}
      sharePct={cur.cost > 0 ? 100 : 0}
      metrics={[
        { label: "Total tokens", value: fmtT(cur.tokens) },
        { label: "Input tokens", value: fmtT(cur.input), tone: "blue" },
        { label: "Output tokens", value: fmtT(cur.output), tone: "cyan" },
        { label: "Caching token", value: fmtT(cachingTokens), tone: "yellow" },
        { label: "Turns", value: cur.turns.toLocaleString() },
        { label: "Tool calls", value: toolCalls.toLocaleString() },
        { label: "Models", value: cur.models.toLocaleString() },
      ]}
    />
  );
}
