import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { agg, computePeriods, currentRangeForPeriod, fmtT } from "../lib/periodData";
import { UsageOverviewCard } from "./UsageOverviewCard";
import type { Period } from "../lib/periodData";

type VisiblePeriod = Exclude<Period, "today">;

const labels: Record<VisiblePeriod, string> = {
  day: "Current Day",
  week: "Current Week",
  month: "Current Month",
  year: "Current Year",
};

const averageLabels: Record<VisiblePeriod, string> = {
  day: "vs 7-day avg",
  week: "vs 7-week avg",
  month: "vs 6-month avg",
  year: "vs 2-year avg",
};

export function CurrentPeriodCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  if (g === "today" || !result || result.view !== "dashboard") { return null; }

  const period = g as VisiblePeriod;
  const range = currentRangeForPeriod(period);
  const current = agg(result.series, range.from, range.to);
  const cachingTokens = result.series.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.cacheReadTokens + row.cacheCreationTokens;
  }, 0);
  const { cur } = computePeriods(result.series, period);
  const averageCost = cur.cost / tabBucketCount(period);
  const delta = averageCost > 0 ? ((current.cost - averageCost) / averageCost) * 100 : current.cost > 0 ? 100 : 0;
  const share = cur.cost > 0 ? (current.cost / cur.cost) * 100 : 0;
  const toolCalls = result.toolCallsByDay.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.count;
  }, 0);
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";

  return (
    <UsageOverviewCard
      title={`${labels[period]}${sourceLabel}`}
      cost={formatCost(current.cost)}
      delta={delta}
      deltaLabel={averageLabels[period]}
      sharePct={share}
      metricGroups={[
        [
          { label: "Total tokens", value: fmtT(current.tokens) },
          { label: "Turns", value: current.turns.toLocaleString() },
          { label: "Tool calls", value: toolCalls.toLocaleString() },
        ],
        [
          { label: "Input tokens", value: fmtT(current.input), tone: "blue" },
          { label: "Caching token", value: fmtT(cachingTokens), tone: "yellow" },
          { label: "Output tokens", value: fmtT(current.output), tone: "cyan" },
        ],
        [
          { label: "Models", value: current.models.toLocaleString() },
        ],
      ]}
    />
  );
}

function tabBucketCount(period: VisiblePeriod): number {
  if (period === "month") { return 6; }
  if (period === "year") { return 2; }
  return 7;
}
