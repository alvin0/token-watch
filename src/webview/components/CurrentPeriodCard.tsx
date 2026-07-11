import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost, formatCostPerTurn } from "../format";
import { agg, computePeriods, currentRangeForPeriod, fmtT } from "../lib/periodData";
import { UsageOverviewCard } from "./UsageOverviewCard";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";

type VisiblePeriod = Exclude<Period, "today">;

export function CurrentPeriodCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  const { locale, t } = useTranslation();
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
  const toolCalls = result.toolCallsByDay.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.count;
  }, 0);
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";
  const cacheInputBase = cachingTokens + current.input;
  const cacheHitPct = cacheInputBase > 0 ? (cachingTokens / cacheInputBase) * 100 : 0;
  const costPerTurn = current.turns > 0 ? current.cost / current.turns : 0;
  const labels: Record<VisiblePeriod, string> = {
    day: t("period.currentDay"), week: t("period.currentWeek"),
    month: t("period.currentMonth"), year: t("period.currentYear"),
  };
  const averageLabels: Record<VisiblePeriod, string> = {
    day: t("period.avg7Day"), week: t("period.avg7Week"),
    month: t("period.avg6Month"), year: t("period.avg2Year"),
  };

  return (
    <UsageOverviewCard
      title={`${labels[period]}${sourceLabel}`}
      cost={formatCost(current.cost)}
      comparisonCost={formatCost(averageCost)}
      delta={delta}
      comparisonLabel={averageLabels[period]}
      totalTokens={fmtT(current.tokens)}
      cachedTokens={fmtT(cachingTokens)}
      inputTokens={fmtT(current.input)}
      outputTokens={fmtT(current.output)}
      cacheHitPct={cacheHitPct}
      turns={current.turns.toLocaleString(locale)}
      toolCalls={toolCalls.toLocaleString(locale)}
      models={current.models.toLocaleString(locale)}
      costPerTurn={formatCostPerTurn(costPerTurn)}
    />
  );
}

function tabBucketCount(period: VisiblePeriod): number {
  if (period === "month") { return 6; }
  if (period === "year") { return 2; }
  return 7;
}
