import { useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { makeBuckets, fmtT } from "../lib/periodData";
import type { Period, ChartMode, Bkt } from "../lib/periodData";

export function TrendChart() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const [mode, setMode] = useState<ChartMode>("Tokens");
  if (!result || result.view !== "dashboard" || result.series.length === 0) { return null; }

  const buckets = makeBuckets(result.series, g).reverse().slice(-12);
  const getVal = (b: Bkt) => mode === "Tokens" ? b.tokens : mode === "Cost" ? b.cost : b.turns;
  const maxV = Math.max(...buckets.map(getVal), 1);

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">Usage trend</span>
        <div className="tw-flex tw-rounded tw-bg-[#0d0d1a] tw-p-[2px]">
          {(["Tokens", "Cost", "Turns"] as ChartMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`tw-px-1.5 tw-py-[2px] tw-text-[8px] tw-rounded tw-cursor-pointer ${
                mode === m ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]" : "tw-text-[var(--vscode-descriptionForeground)]"
              }`}>{m}</button>
          ))}
        </div>
      </div>
      <div className="tw-flex tw-gap-1">
        <div className="tw-flex tw-flex-col tw-justify-between tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)] tw-tabular-nums tw-w-8 tw-shrink-0 tw-h-14">
          <span>{mode === "Cost" ? formatCost(maxV) : fmtT(maxV)}</span>
          <span>{mode === "Cost" ? formatCost(maxV / 2) : fmtT(maxV / 2)}</span>
          <span>0</span>
        </div>
        <div className="tw-flex tw-items-end tw-gap-[3px] tw-flex-1 tw-h-14">
          {buckets.map((b) => {
            const v = getVal(b);
            const h = (v / maxV) * 100;
            return <div key={b.key} className="tw-flex-1 tw-rounded-t-sm"
              style={{ height: `${Math.max(h, 1)}%`, backgroundColor: "#b180d7" }}
              title={`${b.label}: ${mode === "Cost" ? formatCost(v) : fmtT(v)}`} />;
          })}
        </div>
      </div>
      <div className="tw-flex tw-justify-between tw-ml-9 tw-mt-0.5 tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)]">
        <span>{buckets[0]?.label}</span><span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}
