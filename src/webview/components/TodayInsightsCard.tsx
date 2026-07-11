import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { computePeriods, fmtT, pRange } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";

export function TodayInsightsCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { locale, t } = useTranslation();
  if (g !== "today" || !result || result.view !== "dashboard") { return null; }

  const { cur, prev } = computePeriods(result.series, "today");
  if (cur.tokens === 0 && cur.turns === 0) { return null; }

  const { from } = pRange("today");
  const todayRows = result.series.filter((r) => r.day === from);
  const totalTokenParts = cur.input + cur.output + cur.cache + cur.reasoning;
  const cachePct = pct(cur.cache, totalTokenParts);
  const reasoningPct = pct(cur.reasoning, totalTokenParts);
  const tokensPerTurn = cur.turns > 0 ? cur.tokens / cur.turns : 0;
  const costPerTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;
  const topModel = topModelInsight(todayRows, locale, t);
  const costDelta = deltaLabel(cur.cost, prev.cost, t);

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
      detail: t("insights.cacheDetail", { cached: fmtT(cur.cache), input: fmtT(cur.input) }),
      tone: cachePct >= 70 ? "good" : cachePct >= 30 ? "neutral" : "warn",
    },
    {
      label: t("insights.turnWeight"),
      value: fmtT(tokensPerTurn),
      detail: t("insights.turnDetail", { cost: formatCost(costPerTurn), turns: cur.turns.toLocaleString(locale) }),
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
      detail: t("insights.reasoningDetail", { tokens: fmtT(cur.reasoning) }),
      tone: reasoningPct > 15 ? "warn" : reasoningPct > 5 ? "neutral" : "good",
    },
    {
      label: t("insights.outputShape"),
      value: outputShape(cur.input, cur.output),
      detail: t("insights.outputDetail", { output: fmtT(cur.output), input: fmtT(cur.input) }),
      tone: "neutral",
    },
  ] as const;

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">{t("insights.title")}</span>
        <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">{cur.activeDays === 1 ? t("insights.activeToday") : t("insights.noStreak")}</span>
      </div>
      <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
        {insights.map((item) => (
          <div key={item.label} className="tw-rounded-md tw-bg-[#141426] tw-border tw-border-[#25253a] tw-px-2.5 tw-py-2">
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

function deltaLabel(cur: number, prev: number, t: ReturnType<typeof useTranslation>["t"]): { value: string; detail: string; tone: "good" | "neutral" | "warn" } {
  if (prev <= 0) {
    return { value: formatCost(cur), detail: t("insights.noBaseline"), tone: "neutral" };
  }
  const delta = ((cur - prev) / prev) * 100;
  const down = delta <= 0;
  return {
    value: `${down ? "↓" : "↑"} ${Math.abs(delta).toFixed(1)}%`,
    detail: t("insights.todayVsYesterday", { today: formatCost(cur), yesterday: formatCost(prev) }),
    tone: down ? "good" : "warn",
  };
}

function topModelInsight(
  rows: Array<{ variantId: string; totalTokens: number; turns: number }>,
  locale: string,
  t: ReturnType<typeof useTranslation>["t"],
): { value: string; detail: string; tone: "good" | "neutral" | "warn" } {
  const total = rows.reduce((sum, r) => sum + r.totalTokens, 0);
  const top = rows.reduce<{ variantId: string; totalTokens: number; turns: number } | undefined>((best, row) => {
    if (!best || row.totalTokens > best.totalTokens) { return row; }
    return best;
  }, undefined);

  if (!top || total <= 0) {
    return { value: "—", detail: t("insights.noModel"), tone: "neutral" };
  }

  const share = (top.totalTokens / total) * 100;
  return {
    value: top.variantId,
    detail: t("insights.modelDetail", { share: share.toFixed(1), turns: top.turns.toLocaleString(locale) }),
    tone: share >= 90 ? "warn" : "neutral",
  };
}

function outputShape(input: number, output: number): string {
  if (input <= 0) { return "—"; }
  return `${((output / input) * 100).toFixed(1)}%`;
}

function toneClass(tone: "good" | "neutral" | "warn"): string {
  if (tone === "good") { return "tw-text-[#89d185]"; }
  if (tone === "warn") { return "tw-text-[#f0a050]"; }
  return "tw-text-[var(--vscode-foreground)]";
}
