import { formatCost } from "../format";
import { fmtT } from "./periodData";
import type { Bkt, ChartMode, Period } from "./periodData";
import { translate, type AppLanguage } from "../../shared/i18n";

export interface TrendSummary {
  total: number;
  average: number;
  activeCount: number;
  peakIndex: number;
  peakValue: number;
  peakShare: number;
}

export function trendValue(bucket: Bkt, mode: ChartMode): number {
  return mode === "Tokens" ? bucket.tokens : mode === "Cost" ? bucket.cost : bucket.turns;
}

export function summarizeTrend(buckets: Bkt[], mode: ChartMode): TrendSummary {
  const values = buckets.map((bucket) => trendValue(bucket, mode));
  const total = values.reduce((sum, value) => sum + value, 0);
  const peakValue = Math.max(...values, 0);
  const peakIndex = values.indexOf(peakValue);
  return {
    total,
    average: buckets.length > 0 ? total / buckets.length : 0,
    activeCount: values.filter((value) => value > 0).length,
    peakIndex,
    peakValue,
    peakShare: total > 0 ? (peakValue / total) * 100 : 0,
  };
}

export function formatTrendValue(value: number, mode: ChartMode): string {
  if (mode === "Cost") { return formatCost(value); }
  if (mode === "Turns") { return Math.round(value).toLocaleString(); }
  return fmtT(value);
}

export function readableChange(current: number, previous: number, previousLabel: string, language: AppLanguage = "en"): string | undefined {
  if (current === 0 && previous === 0) { return undefined; }
  if (previous === 0) { return translate(language, "trend.startedAfter", { period: previousLabel }); }
  if (current === previous) { return translate(language, "trend.sameAs", { period: previousLabel }); }

  const ratio = current / previous;
  if (ratio >= 2) { return translate(language, "trend.timesHigher", { value: ratio.toFixed(1), period: previousLabel }); }
  if (ratio > 1) { return translate(language, "trend.percentHigher", { value: Math.round((ratio - 1) * 100), period: previousLabel }); }
  if (ratio <= 0.5) { return translate(language, "trend.timesLower", { value: (1 / ratio).toFixed(1), period: previousLabel }); }
  return translate(language, "trend.percentLower", { value: Math.round((1 - ratio) * 100), period: previousLabel });
}

export function trendPeriodLabels(period: Period, language: AppLanguage = "en"): { average: string; active: string } {
  if (period === "week") { return { average: translate(language, "trend.weeklyAvg"), active: translate(language, "trend.activeWeeks") }; }
  if (period === "month") { return { average: translate(language, "trend.monthlyAvg"), active: translate(language, "trend.activeMonths") }; }
  if (period === "year") { return { average: translate(language, "trend.yearlyAvg"), active: translate(language, "trend.activeYears") }; }
  return { average: translate(language, "trend.dailyAvg"), active: translate(language, "trend.activeDays") };
}
