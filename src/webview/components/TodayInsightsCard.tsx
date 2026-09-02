import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { useCostFormat, type CostFormatter } from "../hooks/useCostFormat";
import { computePeriods, fmtT, pRange } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";
import { summarizeModels } from "../../shared/modelSummary";
import type { DailyAggregate } from "../../shared/storeTypes";

export function TodayInsightsCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { locale, t } = useTranslation();
  const money = useCostFormat();
  if (g !== "today" || !result || result.view !== "dashboard") { return null; }

  const { cur, prev } = computePeriods(result.series, "today", locale);
  if (cur.tokens === 0 && cur.turns === 0) { return null; }

  const { from } = pRange("today");
  const todayRows = result.series.filter((r) => r.day === from);
  // Cache leverage is the read hit rate: cache CREATION is a miss that fills
  // the cache, so counting it here would make a cold cache look warm.
  const cachePct = cur.metrics.cacheHitPct;
  const reasoningPct = pct(cur.metrics.reasoning, cur.metrics.breakdownTotal);
  const tokensPerTurn = cur.turns > 0 ? cur.metrics.total / cur.turns : 0;
  const costPerTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;
  const topModel = topModelInsight(todayRows, locale, t);
  const costDelta = deltaLabel(cur.cost, prev.cost, t, money);

  const insights = [
    {
      label: t("insights.vsYesterday"),
      value: costDelta.value,
      detail: costDelta.detail,
      tone: costDelta.tone,
    },
    {
      label: t("insights.cacheLeverage"),
      value: `${cachePct.toFixed(1)}%`,
      detail: t("insights.cacheDetail", { cached: fmtT(cur.metrics.cacheRead), input: fmtT(cur.metrics.input) }),
      tone: cachePct >= 70 ? "good" : cachePct >= 30 ? "neutral" : "warn",
    },
    {
      label: t("insights.turnWeight"),
      value: fmtT(tokensPerTurn),
      detail: t("insights.turnDetail", { cost: money.cost(costPerTurn), turns: cur.turns.toLocaleString(locale) }),
      tone: tokensPerTurn >= 100_000 ? "warn" : "neutral",
    },
    {
      label: t("insights.mainModel"),
      value: topModel.value,
      detail: topModel.detail,
      tone: topModel.tone,
    },
    {
      label: t("insights.reasoningMix"),
      value: `${reasoningPct.toFixed(1)}%`,
      detail: t("insights.reasoningDetail", { tokens: fmtT(cur.metrics.reasoning) }),
      tone: reasoningPct > 15 ? "warn" : reasoningPct > 5 ? "neutral" : "good",
    },
    {
      label: t("insights.outputShape"),
      value: outputShape(cur.metrics.input, cur.metrics.output),
      detail: t("insights.outputDetail", { output: fmtT(cur.metrics.output), input: fmtT(cur.metrics.input) }),
      tone: "neutral",
    },
  ] as const;

  return (
    <div className="tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">{t("insights.title")}</span>
        <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">{cur.activeDays === 1 ? t("insights.activeToday") : t("insights.noStreak")}</span>
      </div>
      <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
        {insights.map((item) => (
          <div key={item.label} className="tw-rounded-md tw-bg-recessed tw-border tw-border-edge tw-px-2.5 tw-py-2">
            <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)] tw-mb-0.5">{item.label}</div>
            <div className={`tw-text-[13px] tw-font-bold tw-tabular-nums ${toneClass(item.tone)}`}>{item.value}</div>
            <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)] tw-leading-snug tw-mt-0.5">{item.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function deltaLabel(
  cur: number,
  prev: number,
  t: ReturnType<typeof useTranslation>["t"],
  money: CostFormatter,
): { value: string; detail: string; tone: "good" | "neutral" | "warn" } {
  if (prev <= 0) {
    return { value: money.cost(cur), detail: t("insights.noBaseline"), tone: "neutral" };
  }
  const delta = ((cur - prev) / prev) * 100;
  const down = delta <= 0;
  return {
    value: `${down ? "↓" : "↑"} ${Math.abs(delta).toFixed(1)}%`,
    detail: t("insights.todayVsYesterday", { today: money.cost(cur), yesterday: money.cost(prev) }),
    tone: down ? "good" : "warn",
  };
}

function topModelInsight(
  rows: DailyAggregate[],
  locale: string,
  t: ReturnType<typeof useTranslation>["t"],
): { value: string; detail: string; tone: "good" | "neutral" | "warn" } {
  // Roll up first: a model split across workspaces is still one model, and a
  // model id shared by Codex and Claude is two.
  const [top] = summarizeModels(rows);

  if (!top || top.total <= 0) {
    return { value: "—", detail: t("insights.noModel"), tone: "neutral" };
  }

  return {
    value: top.baseModel,
    detail: t("insights.modelDetail", { share: top.share.toFixed(1), turns: top.turns.toLocaleString(locale) }),
    tone: top.share >= 90 ? "warn" : "neutral",
  };
}

function outputShape(input: number, output: number): string {
  if (input <= 0) { return "—"; }
  return `${((output / input) * 100).toFixed(1)}%`;
}

function toneClass(tone: "good" | "neutral" | "warn"): string {
  if (tone === "good") { return "tw-text-chart-green"; }
  if (tone === "warn") { return "tw-text-chart-orange"; }
  return "tw-text-[var(--vscode-foreground)]";
}
