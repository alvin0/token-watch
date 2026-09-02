import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { useCostFormat } from "../hooks/useCostFormat";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";

export function InsightCards() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { locale, t } = useTranslation();
  const money = useCostFormat();
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, peakLabel } = computePeriods(result.series, g, locale);

  if (g === "today") {
    const cacheHit = cur.metrics.cacheHitPct;
    const tokensPerTurn = cur.turns > 0 ? cur.metrics.total / cur.turns : 0;
    const reasoningMix = cur.metrics.breakdownTotal > 0
      ? (cur.metrics.reasoning / cur.metrics.breakdownTotal) * 100
      : 0;

    return (
      <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
        <MiniCard icon="" label={t("insights.cacheHit")} value={`${cacheHit.toFixed(1)}%`} />
        <MiniCard icon="" label={t("insights.tokensPerTurn")} value={fmtT(tokensPerTurn)} />
        <MiniCard icon="" label={t("insights.turnsToday")} value={cur.turns.toLocaleString(locale)} />
        <MiniCard icon="" label={t("insights.reasoningMix")} value={`${reasoningMix.toFixed(1)}%`} />
      </div>
    );
  }

  // Cache savings: use blended cost per 1K from variants to estimate input vs cached rate spread
  // Approximate: savings = cacheReadTokens * (blendedInputRate - blendedCacheRate)
  // Since we don't have per-model rates in the webview, use the variant data to derive
  // a weighted average spread. Fallback to a conservative estimate.
  let cacheSaved = 0;
  if (result.variants && result.variants.length > 0) {
    // Weighted average blendedCostPer1K gives us an approximation
    const totalCost = result.variants.reduce((s, v) => s + v.costUsd, 0);
    const totalTokens = result.variants.reduce((s, v) => s + v.totalTokens, 0);
    const avgRatePer1K = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : 0.005;
    // Cache savings ≈ cacheReadTokens * avgRatePer1K * 0.5 (cache is ~50% cheaper)
    cacheSaved = (cur.metrics.cacheRead / 1000) * avgRatePer1K * 0.5;
  } else {
    cacheSaved = (cur.metrics.cacheRead / 1000) * (0.005 - 0.0025);
  }
  const avgTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;

  return (
    <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
      <MiniCard icon="" label={t("insights.cacheSaved")} value={money.cost(cacheSaved)} />
      <MiniCard icon="" label={t("insights.avgPerTurn")} value={money.cost(avgTurn)} />
      <MiniCard icon="" label={t("insights.activeModels")} value={String(cur.models)} />
      <MiniCard icon="" label={t("insights.peak")} value={peakLabel} />
    </div>
  );
}

function MiniCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="tw-rounded-md tw-border tw-border-edge tw-bg-card tw-px-2.5 tw-py-2">
      <div className="tw-flex tw-items-center tw-gap-1 tw-mb-0.5">
        <span className="tw-text-[10px]">{icon}</span>
        <span className="tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">{label}</span>
      </div>
      <div className="tw-text-[13px] tw-font-bold tw-tabular-nums">{value}</div>
    </div>
  );
}
