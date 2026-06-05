import { useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { fmtT, pRange } from "../lib/periodData";
import type { ChartMode } from "../lib/periodData";
import type { HourlyAggregate } from "../../shared/storeTypes";

interface HourBucket {
  hour: number;
  label: string;
  tokens: number;
  cost: number;
  turns: number;
  input: number;
  output: number;
  cache: number;
  reasoning: number;
}

export function TodayUsageTrend() {
  const result = useQuery("dashboard");
  const granularity = useStore((s) => s.granularity);
  const [mode, setMode] = useState<ChartMode>("Tokens");
  if (granularity !== "today" || !result || result.view !== "dashboard") { return null; }

  const today = pRange("today").from;
  const buckets = hourlyBuckets(result.hourlySeries, today);
  const totalTokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const totalTurns = buckets.reduce((sum, bucket) => sum + bucket.turns, 0);
  if (totalTokens === 0 && totalTurns === 0) { return null; }

  const getVal = (bucket: HourBucket) => (
    mode === "Tokens" ? bucket.tokens : mode === "Cost" ? bucket.cost : bucket.turns
  );
  const maxV = Math.max(...buckets.map(getVal), 1);
  const peak = buckets.reduce((best, bucket) => getVal(bucket) > getVal(best) ? bucket : best, buckets[0]);
  const totalValue = buckets.reduce((sum, bucket) => sum + getVal(bucket), 0);
  const activeHours = buckets.filter((bucket) => bucket.turns > 0).length;

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-mb-2 tw-flex tw-items-center tw-justify-between tw-gap-2">
        <div className="tw-min-w-0">
          <div className="tw-text-[10px] tw-font-medium">Usage trend</div>
          <div className="tw-mt-0.5 tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
            Hourly today - peak {peak.label}
          </div>
        </div>
        <div className="tw-flex tw-shrink-0 tw-rounded tw-bg-[#0d0d1a] tw-p-[2px]">
          {(["Tokens", "Cost", "Turns"] as ChartMode[]).map((item) => (
            <button key={item} onClick={() => setMode(item)}
              className={`tw-cursor-pointer tw-rounded tw-px-1.5 tw-py-[2px] tw-text-[8px] ${
                mode === item ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]" : "tw-text-[var(--vscode-descriptionForeground)]"
              }`}>{item}</button>
          ))}
        </div>
      </div>

      <div className="tw-flex tw-gap-2">
        <div className="tw-flex tw-h-24 tw-w-9 tw-shrink-0 tw-flex-col tw-justify-between tw-text-[8px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
          <span>{formatValue(maxV, mode)}</span>
          <span>{formatValue(maxV / 2, mode)}</span>
          <span>0</span>
        </div>
        <div className="tw-min-w-0 tw-flex-1">
          <div className="tw-flex tw-h-24 tw-items-end tw-gap-[3px]">
            {buckets.map((bucket) => {
              const value = getVal(bucket);
              const height = value > 0 ? Math.max((value / maxV) * 100, 2) : 0;
              return (
                <div key={bucket.hour} className="tw-flex tw-h-full tw-flex-1 tw-items-end" title={hourTitle(bucket)}>
                  <div className="tw-w-full tw-rounded-t-sm tw-bg-[#4fc1ff]" style={{ height: `${height}%` }} />
                </div>
              );
            })}
          </div>
          <div className="tw-mt-1 tw-grid tw-grid-cols-6 tw-text-[7px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
            {(["00", "04", "08", "12", "16", "20"] as const).map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="tw-mt-2 tw-flex tw-items-center tw-justify-between tw-gap-2 tw-text-[8px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
        <span>Total {formatValue(totalValue, mode)}</span>
        <span>{activeHours} active hours</span>
      </div>
    </div>
  );
}

function hourlyBuckets(rows: HourlyAggregate[], day: string): HourBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => emptyHourBucket(hour));
  for (const row of rows) {
    if (row.day !== day || row.hour < 0 || row.hour > 23) {
      continue;
    }
    const bucket = buckets[row.hour];
    bucket.tokens += row.totalTokens;
    bucket.cost += row.costUsd;
    bucket.turns += row.turns;
    bucket.input += row.inputTokens;
    bucket.output += row.outputTokens;
    bucket.cache += row.cacheReadTokens + row.cacheCreationTokens;
    bucket.reasoning += row.reasoningTokens;
  }
  return buckets;
}

function emptyHourBucket(hour: number): HourBucket {
  return {
    hour,
    label: `${hourShort(hour)}:00`,
    tokens: 0,
    cost: 0,
    turns: 0,
    input: 0,
    output: 0,
    cache: 0,
    reasoning: 0,
  };
}

function formatValue(value: number, mode: ChartMode): string {
  if (mode === "Cost") { return formatCost(value); }
  if (mode === "Turns") { return Math.round(value).toLocaleString(); }
  return fmtT(value);
}

function hourShort(hour: number): string {
  return String(hour).padStart(2, "0");
}

function hourTitle(bucket: HourBucket): string {
  return `${bucket.label}: ${fmtT(bucket.tokens)} tokens, ${formatCost(bucket.cost)}, ${bucket.turns.toLocaleString()} turns`
    + `\nInput ${fmtT(bucket.input)} - Output ${fmtT(bucket.output)} - Cache ${fmtT(bucket.cache)} - Reasoning ${fmtT(bucket.reasoning)}`;
}
