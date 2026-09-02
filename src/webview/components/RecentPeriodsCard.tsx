import { useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { useCostFormat } from "../hooks/useCostFormat";
import { makeBuckets, fmtT } from "../lib/periodData";
import type { Bkt, Period } from "../lib/periodData";
import { useTranslation } from "../i18n";
import { Chevron } from "./Chevron";

export function RecentPeriodsCard() {
  const [expanded, setExpanded] = useState(false);
  const result = useQuery("dashboard");
  const period = useStore((state) => state.granularity) as Period;
  const { locale, t } = useTranslation();
  const money = useCostFormat();
  if (!result || result.view !== "dashboard" || result.series.length === 0) { return null; }

  const buckets = makeBuckets(result.series, period, new Date(), locale);
  const total = sumBuckets(buckets);

  return (
    <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-edge tw-bg-card">
      <div className="tw-p-3">
        <div className="tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">{t("recent.title")}</div>

        {!expanded && (
          <>
            <div className="tw-mt-2 tw-flex tw-items-baseline tw-justify-between tw-gap-3 tw-text-[9px]">
              <span className="tw-text-[var(--vscode-descriptionForeground)]">{t("common.total")}</span>
              <span className="tw-text-right tw-font-medium tw-tabular-nums">
                {fmtT(total.tokens)} {t("common.tokens")} · {money.cost(total.cost)}
              </span>
            </div>
            <div className="tw-mt-1 tw-text-[8px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
              {summaryBreakdown(total, t)}
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="tw-overflow-x-auto tw-border-t tw-border-edge">
          <table className="tw-w-full tw-table-fixed tw-border-collapse tw-tabular-nums">
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "19%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "19%" }} />
            </colgroup>
            <thead>
              <tr className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
                <th className="tw-px-3 tw-py-2 tw-text-left tw-font-medium">{t("recent.date")}</th>
                <th className="tw-px-1 tw-py-2 tw-text-right tw-font-medium">{t("common.input")}</th>
                <th className="tw-px-1 tw-py-2 tw-text-right tw-font-medium">{t("common.output")}</th>
                <th className="tw-px-1 tw-py-2 tw-text-right tw-font-medium">{t("common.cacheRead")}</th>
                <th className="tw-px-1 tw-py-2 tw-text-right tw-font-medium">{t("common.cacheWrite")}</th>
                <th className="tw-px-3 tw-py-2 tw-text-right tw-font-medium">{t("common.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key} className="tw-border-t tw-border-edge tw-text-[9px] hover:tw-bg-hover">
                  <td className="tw-truncate tw-px-3 tw-py-1.5 tw-text-left tw-font-medium" title={bucket.label}>{bucket.label}</td>
                  <MetricCell value={bucket.input} />
                  <MetricCell value={bucket.output} />
                  <MetricCell value={bucket.cache} />
                  <MetricCell value={bucket.cacheWrite} />
                  <td className="tw-whitespace-nowrap tw-px-3 tw-py-1.5 tw-text-right tw-text-[var(--vscode-descriptionForeground)]">
                    {bucket.cost > 0 ? money.cost(bucket.cost) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-edge tw-bg-recessed tw-px-3 tw-py-2 tw-text-left hover:tw-bg-hover"
      >
        <span className="tw-min-w-0 tw-truncate tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
          {periodSpanLabel(period, t)}
        </span>
        <span className="tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)]">
          {expanded ? t("common.showLess") : t("common.showMore")}
          <Chevron up={expanded} />
        </span>
      </button>
    </section>
  );
}

function sumBuckets(buckets: Bkt[]): Bkt {
  return buckets.reduce<Bkt>((total, bucket) => ({
    ...total,
    tokens: total.tokens + bucket.tokens,
    cost: total.cost + bucket.cost,
    turns: total.turns + bucket.turns,
    input: total.input + bucket.input,
    output: total.output + bucket.output,
    cache: total.cache + bucket.cache,
    cacheWrite: total.cacheWrite + bucket.cacheWrite,
    reasoning: total.reasoning + bucket.reasoning,
  }), {
    key: "total",
    label: "Total",
    tokens: 0,
    cost: 0,
    turns: 0,
    input: 0,
    output: 0,
    cache: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
}

function summaryBreakdown(bucket: Bkt, t: ReturnType<typeof useTranslation>["t"]): string {
  const parts = [
    `${t("common.input")} ${fmtT(bucket.input)}`,
    `${t("common.output")} ${fmtT(bucket.output)}`,
  ];
  if (bucket.reasoning > 0) { parts.push(`${t("common.reasoning")} ${fmtT(bucket.reasoning)}`); }
  parts.push(`${t("common.cacheRead")} ${fmtT(bucket.cache)}`);
  if (bucket.cacheWrite > 0) { parts.push(`${t("common.cacheWrite")} ${fmtT(bucket.cacheWrite)}`); }
  return parts.join(" · ");
}

function metricValue(value: number): string {
  return value > 0 ? fmtT(value) : "–";
}

function MetricCell({ value }: { value: number }) {
  return (
    <td className="tw-whitespace-nowrap tw-px-1 tw-py-1.5 tw-text-right tw-text-[var(--vscode-descriptionForeground)]">
      {metricValue(value)}
    </td>
  );
}

function periodSpanLabel(period: Period, t: ReturnType<typeof useTranslation>["t"]): string {
  if (period === "month") { return t("recent.last6Months"); }
  if (period === "year") { return t("recent.last2Years"); }
  if (period === "week") { return t("recent.last7Weeks"); }
  return t("recent.last7Days");
}
