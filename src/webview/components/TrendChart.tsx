import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { makeBuckets, previousPeriodAnchor } from "../lib/periodData";
import {
  formatTrendValue,
  readableChange,
  summarizeTrend,
  trendPeriodLabels,
  trendValue,
} from "../lib/trendData";
import { useChartPalette } from "../hooks/useChartPalette";
import type { Period, ChartMode, Bkt } from "../lib/periodData";
import { useTranslation } from "../i18n";

type TokenView = "Total" | "Breakdown";

interface TrendDatum extends Bkt {
  current: number;
  previous: number;
  previousLabel: string;
  priorBucket?: Bkt;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: TrendDatum }>;
  mode: ChartMode;
  total: number;
  breakdown: boolean;
}


export function TrendChart() {
  const palette = useChartPalette();
  const result = useQuery("dashboard");
  const period = useStore((s) => s.granularity) as Period;
  const [mode, setMode] = useState<ChartMode>("Tokens");
  const [tokenView, setTokenView] = useState<TokenView>("Total");
  const { language, t } = useTranslation();

  const buckets = useMemo(
    () => result?.view === "dashboard" ? makeBuckets(result.series, period).reverse() : [],
    [result, period],
  );
  const previousBuckets = useMemo(
    () => result?.view === "dashboard"
      ? makeBuckets(result.series, period, previousPeriodAnchor(period)).reverse()
      : [],
    [result, period],
  );
  const data = useMemo<TrendDatum[]>(() => buckets.map((bucket, index) => ({
    ...bucket,
    current: trendValue(bucket, mode),
    previous: trendValue(previousBuckets[index] ?? bucket, mode),
    previousLabel: previousBuckets[index]?.label ?? t("trend.previousPeriod"),
    priorBucket: buckets[index - 1],
  })), [buckets, previousBuckets, mode, t]);

  if (!result || result.view !== "dashboard" || result.series.length === 0) { return null; }

  const summary = summarizeTrend(buckets, mode);
  const labels = trendPeriodLabels(period, language);
  const peak = data[summary.peakIndex];
  const breakdown = mode === "Tokens" && tokenView === "Breakdown";
  const hasPrevious = previousBuckets.some((bucket) => trendValue(bucket, mode) > 0);

  return (
    <section className="tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-p-3">
      <div className="tw-flex tw-flex-wrap tw-items-center tw-justify-between tw-gap-2">
        <h2 className="tw-m-0 tw-text-[11px] tw-font-semibold tw-uppercase tw-tracking-wide">{t("trend.title")}</h2>
        <SegmentedControl values={["Tokens", "Cost", "Turns"]} value={mode} onChange={(value) => setMode(value as ChartMode)} labelFor={(value) => value === "Tokens" ? t("common.tokens") : value === "Cost" ? t("common.cost") : t("common.turns")} />
      </div>

      {mode === "Tokens" && (
        <div className="tw-mt-2">
          <SegmentedControl values={["Total", "Breakdown"]} value={tokenView} onChange={(value) => setTokenView(value as TokenView)} labelFor={(value) => value === "Total" ? t("trend.totalView") : t("trend.breakdown")} />
        </div>
      )}

      <div className="tw-mt-3 tw-grid tw-grid-cols-3 tw-gap-x-3 tw-gap-y-1 tw-text-[8px] tw-tabular-nums max-[360px]:tw-grid-cols-1">
        <Stat value={t("trend.totalValue", { value: formatTrendValue(summary.total, mode) })} />
        <Stat value={`${formatTrendValue(summary.average, mode)} ${labels.average}`} />
        <Stat value={t("trend.activeBuckets", { active: summary.activeCount, total: buckets.length, label: labels.active })} />
        <div className="tw-col-span-full tw-text-[var(--vscode-descriptionForeground)]">
          <span className="tw-text-[var(--vscode-foreground)]">{t("trend.peak", { label: peak?.label ?? "-", value: formatTrendValue(summary.peakValue, mode), share: summary.peakShare.toFixed(1) })}</span>
        </div>
      </div>

      <div className="tw-mt-2 tw-h-36 tw-w-full">
        <ResponsiveContainer width="100%" height="100%">
          {breakdown ? (
            <BarChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: -12 }}>
              <ChartAxes mode={mode} />
              <Tooltip content={<TrendTooltip mode={mode} total={summary.total} breakdown />} />
              <Bar dataKey="cache" stackId="tokens" fill={palette.cacheRead} radius={[2, 2, 0, 0]} />
              <Bar dataKey="input" stackId="tokens" fill={palette.input} />
              <Bar dataKey="output" stackId="tokens" fill={palette.output} radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 18, right: 16, bottom: 0, left: -12 }}>
              <ChartAxes mode={mode} />
              <Tooltip content={<TrendTooltip mode={mode} total={summary.total} breakdown={false} />} />
              {hasPrevious && (
                <Line type="linear" dataKey="previous" stroke={palette.muted} strokeOpacity={0.45} strokeDasharray="4 4" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} />
              )}
              <Line type="linear" dataKey="current" stroke={palette.reasoning} strokeWidth={2} dot={<ActivityDot />} activeDot={{ r: 5 }} isAnimationActive={false} />
              {peak && summary.peakValue > 0 && (
                <ReferenceDot
                  x={peak.label}
                  y={summary.peakValue}
                  r={4}
                  fill={palette.reasoning}
                  stroke={palette.reasoning}
                  label={{ value: formatTrendValue(summary.peakValue, mode), position: "top", fill: "var(--vscode-foreground)", fontSize: 8 }}
                />
              )}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      <div className="tw-ml-8 tw-mr-4 tw-flex tw-items-start tw-text-center tw-text-[7px] tw-leading-tight tw-text-[var(--vscode-descriptionForeground)] tw-tabular-nums">
        {buckets.map((bucket) => (
          <span key={bucket.key} className="tw-min-w-0 tw-flex-1 tw-whitespace-nowrap">
            {shortTimeLabel(bucket.label, period)}
          </span>
        ))}
      </div>

      <div className="tw-mt-2 tw-flex tw-flex-wrap tw-gap-x-4 tw-gap-y-1 tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)]">
        {breakdown ? (
          <>
            <LegendDot color={palette.cacheRead} label={t("common.cacheRead")} />
            <LegendDot color={palette.input} label={t("common.input")} />
            <LegendDot color={palette.output} label={t("common.output")} />
            <span>{t("trend.tooltipHint")}</span>
          </>
        ) : (
          <>
            <LegendLine color={palette.reasoning} label={t("trend.currentPeriod")} />
            {hasPrevious && <LegendLine color={palette.muted} label={t("trend.previousPeriod")} dashed />}
          </>
        )}
      </div>
    </section>
  );
}

function SegmentedControl({ values, value, onChange, labelFor }: { values: string[]; value: string; onChange: (value: string) => void; labelFor?: (value: string) => string }) {
  return (
    <div className="tw-inline-flex tw-rounded tw-bg-track tw-p-[2px]">
      {values.map((item) => (
        <button key={item} onClick={() => onChange(item)} className={`tw-cursor-pointer tw-rounded tw-px-2 tw-py-[2px] tw-text-[8px] ${
          value === item ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]" : "tw-text-[var(--vscode-descriptionForeground)]"
        }`}>{labelFor?.(item) ?? item}</button>
      ))}
    </div>
  );
}

function ChartAxes({ mode }: { mode: ChartMode }) {
  const palette = useChartPalette();
  return (
    <>
      <CartesianGrid vertical={false} stroke={palette.grid} strokeOpacity={0.35} />
      <XAxis dataKey="label" tick={false} tickLine={false} axisLine={false} height={4} />
      <YAxis tickFormatter={(value: number) => formatTrendValue(value, mode)} tick={{ fill: "var(--vscode-descriptionForeground)", fontSize: 7 }} tickLine={false} axisLine={false} width={44} domain={[0, "auto"]} />
    </>
  );
}

function shortTimeLabel(label: string, period: Period): string {
  if (period === "week") { return label.split(" – ")[0] ?? label; }
  if (period === "month") { return label.split(" ")[0] ?? label; }
  return label;
}

function ActivityDot({ cx, cy, value }: { cx?: number; cy?: number; value?: number }) {
  const palette = useChartPalette();
  if (cx === undefined || cy === undefined) { return null; }
  const active = (value ?? 0) > 0;
  return <circle cx={cx} cy={cy} r={active ? 3.5 : 3} fill={active ? palette.reasoning : palette.surface} stroke={palette.reasoning} strokeWidth={1.5} />;
}

function TrendTooltip({ active, payload, mode, total, breakdown }: TooltipProps) {
  const { language, t } = useTranslation();
  const point = payload?.[0]?.payload;
  if (!active || !point) { return null; }
  const current = trendValue(point, mode);
  const previous = point.priorBucket ? trendValue(point.priorBucket, mode) : undefined;
  const change = previous === undefined ? undefined : readableChange(current, previous, point.priorBucket?.label ?? t("trend.previousPeriod"), language);
  return (
    <div className="tw-min-w-40 tw-rounded tw-border tw-border-edge tw-bg-[var(--vscode-editorHoverWidget-background)] tw-p-2 tw-text-[8px] tw-shadow-widget">
      <div className="tw-mb-1 tw-font-semibold">{point.label}</div>
      <TooltipRow label={t("common.cost")} value={formatTrendValue(point.cost, "Cost")} />
      <TooltipRow label={t("common.tokens")} value={formatTrendValue(point.tokens, "Tokens")} />
      <TooltipRow label={t("common.turns")} value={formatTrendValue(point.turns, "Turns")} />
      {breakdown && (
        <div className="tw-mt-1 tw-border-t tw-border-edge tw-pt-1">
          <TooltipRow label={t("common.cacheRead")} value={formatTrendValue(point.cache, "Tokens")} />
          <TooltipRow label={t("common.input")} value={formatTrendValue(point.input, "Tokens")} />
          <TooltipRow label={t("common.output")} value={formatTrendValue(point.output, "Tokens")} />
          {point.reasoning > 0 && <TooltipRow label={t("common.reasoning")} value={formatTrendValue(point.reasoning, "Tokens")} />}
          {point.cacheWrite > 0 && <TooltipRow label={t("common.cacheWrite")} value={formatTrendValue(point.cacheWrite, "Tokens")} />}
        </div>
      )}
      <div className="tw-mt-1 tw-text-[var(--vscode-descriptionForeground)]">
        {total > 0 && <div>{t("trend.periodShare", { value: ((current / total) * 100).toFixed(1), metric: mode === "Tokens" ? t("common.tokens").toLocaleLowerCase() : mode === "Cost" ? t("common.cost").toLocaleLowerCase() : t("common.turns").toLocaleLowerCase() })}</div>}
        {change && <div>{change}</div>}
      </div>
    </div>
  );
}

function Stat({ value }: { value: string }) {
  return <div className="tw-text-[var(--vscode-descriptionForeground)]"><span className="tw-text-[var(--vscode-foreground)] tw-font-medium">{value}</span></div>;
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return <div className="tw-flex tw-justify-between tw-gap-5 tw-tabular-nums"><span>{label}</span><span>{value}</span></div>;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return <span className="tw-flex tw-items-center tw-gap-1"><i className="tw-h-2 tw-w-2 tw-rounded-sm" style={{ backgroundColor: color }} />{label}</span>;
}

function LegendLine({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return <span className="tw-flex tw-items-center tw-gap-1"><i className={`tw-w-4 tw-border-t ${dashed ? "tw-border-dashed" : ""}`} style={{ borderColor: color }} />{label}</span>;
}
