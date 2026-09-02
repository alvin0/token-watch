import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { useCostFormat } from "../hooks/useCostFormat";
import { computePeriods, pRange } from "../lib/periodData";
import { UsageOverviewCard } from "./UsageOverviewCard";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";

export function SummaryCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  const { locale, t } = useTranslation();
  const money = useCostFormat();
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, prev } = computePeriods(result.series, g, locale);
  const range = pRange(g);
  const toolCalls = result.toolCallsByDay.reduce((sum, row) => {
    if (row.day < range.from || row.day > range.to) { return sum; }
    return sum + row.count;
  }, 0);
  const delta = prev.cost > 0 ? ((cur.cost - prev.cost) / prev.cost) * 100 : cur.cost > 0 ? 100 : 0;
  const costPerTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";
  const labels: Record<Period, string> = {
    today: t("period.todayCost", { source: sourceLabel }),
    day: t("period.last7DaysCost", { source: sourceLabel }),
    week: t("period.last7WeeksCost", { source: sourceLabel }),
    month: t("period.last6MonthsCost", { source: sourceLabel }),
    year: t("period.last2YearsCost", { source: sourceLabel }),
  };
  const vs: Record<Period, string> = {
    today: t("period.yesterday"), day: t("period.previous7Days"),
    week: t("period.previous7Weeks"), month: t("period.previous6Months"),
    year: t("period.previous2Years"),
  };

  return (
    <UsageOverviewCard
      title={labels[g]}
      cost={money.cost(cur.cost)}
      comparisonCost={money.cost(prev.cost)}
      delta={delta}
      comparisonLabel={vs[g]}
      metrics={cur.metrics}
      turns={cur.turns.toLocaleString(locale)}
      toolCalls={toolCalls.toLocaleString(locale)}
      models={cur.models.toLocaleString(locale)}
      costPerTurn={money.perTurn(costPerTurn)}
    />
  );
}
