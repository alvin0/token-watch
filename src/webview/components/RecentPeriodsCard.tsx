import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { makeBuckets, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";

export function RecentPeriodsCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  if (!result || result.view !== "dashboard" || result.series.length === 0) { return null; }
  const buckets = makeBuckets(result.series, g).slice(0, g === "day" ? 7 : 6);
  const maxT = Math.max(...buckets.map((b) => b.tokens), 1);

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">Recent periods</span>
        <div className="tw-flex tw-gap-3 tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)] tw-uppercase">
          <span>tokens</span><span>cost</span>
        </div>
      </div>
      <div className="tw-space-y-1">
        {buckets.map((b) => (
          <div key={b.key} className="tw-flex tw-items-center tw-gap-1.5 tw-text-[9px]">
            <span className="tw-w-[44px] tw-shrink-0 tw-text-[var(--vscode-foreground)]">{b.label}</span>
            <span className="tw-w-[38px] tw-shrink-0 tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">{fmtT(b.tokens)}</span>
            <span className="tw-w-[48px] tw-shrink-0 tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">{formatCost(b.cost)}</span>
            <div className="tw-flex-1 tw-h-[6px] tw-rounded-sm tw-overflow-hidden tw-bg-[#0d0d1a]">
              <div className="tw-h-full tw-flex tw-rounded-sm tw-overflow-hidden" style={{ width: `${(b.tokens / maxT) * 100}%` }}>
                {b.input > 0 && <div style={{ flex: b.input, backgroundColor: "#4fc1ff" }} />}
                {b.output > 0 && <div style={{ flex: b.output, backgroundColor: "#cca700" }} />}
                {b.cache > 0 && <div style={{ flex: b.cache, backgroundColor: "#50c8a8" }} />}
                {b.reasoning > 0 && <div style={{ flex: b.reasoning, backgroundColor: "#b180d7" }} />}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
