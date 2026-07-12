import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";

export function InsightCards() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { locale, t } = useTranslation();
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, peakLabel } = computePeriods(result.series, g);

  if (g === "today") {
    const inputBase = cur.input + cur.cache;
    const tokenParts = cur.input + cur.output + cur.cache + cur.reasoning;
    const cacheHit = inputBase > 0 ? (cur.cache / inputBase) * 100 : 0;
    const tokensPerTurn = cur.turns > 0 ? cur.tokens / cur.turns : 0;
    const reasoningMix = tokenParts > 0 ? (cur.reasoning / tokenParts) * 100 : 0;

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
    cacheSaved = (cur.cache / 1000) * avgRatePer1K * 0.5;
  } else {
    cacheSaved = (cur.cache / 1000) * (0.005 - 0.0025);
  }
  const avgTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;

  return (
    <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
      <MiniCard icon="" label={t("insights.cacheSaved")} value={formatCost(cacheSaved)} />
      <MiniCard icon="" label={t("insights.avgPerTurn")} value={formatCost(avgTurn)} />
      <MiniCard icon="" label={t("insights.activeModels")} value={String(cur.models)} />
      <MiniCard icon="" label={t("insights.peak")} value={peakLabel} />
    </div>
  );
}

function MiniCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="tw-rounded-md tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-px-2.5 tw-py-2">
      <div className="tw-flex tw-items-center tw-gap-1 tw-mb-0.5">
        <span className="tw-text-[10px]">{icon}</span>
        <span className="tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">{label}</span>
      </div>
      <div className="tw-text-[13px] tw-font-bold tw-tabular-nums">{value}</div>
    </div>
  );
}
