import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";

export function SummaryCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const sources = useStore((s) => s.sources);
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, prev } = computePeriods(result.series, g);
  const delta = prev.cost > 0 ? ((cur.cost - prev.cost) / prev.cost) * 100 : 0;
  const isDown = delta <= 0;
  const sourceLabel = !sources ? "" : sources.length === 1 ? ` (${sources[0]})` : "";
  const labels: Record<Period, string> = {
    today: `Today cost${sourceLabel}`,
    day: `Last 7 days cost${sourceLabel}`,
    week: `Last 7 weeks cost${sourceLabel}`,
    month: `Last 6 months cost${sourceLabel}`,
    year: `Last 2 years cost${sourceLabel}`,
  };
  const vs: Record<Period, string> = {
    today: "vs yesterday",
    day: "vs previous 7 days",
    week: "vs previous 7 weeks",
    month: "vs previous 6 months",
    year: "vs previous 2 years",
  };

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-start tw-justify-between">
        <div>
          <div className="tw-text-[22px] tw-font-bold tw-tabular-nums tw-text-[var(--vscode-foreground)]">{formatCost(cur.cost)}</div>
          <div className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{labels[g]}</div>
          <div className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)] tw-mt-0.5">
            {fmtT(cur.tokens)} tokens • {cur.turns.toLocaleString()} turns
            <span> • {cur.activeDays} day{cur.activeDays !== 1 ? "s" : ""} active</span>
          </div>
        </div>
        {prev.cost > 0 && (
          <div className="tw-text-right">
            <span className={`tw-text-[11px] tw-font-semibold ${isDown ? "tw-text-[#89d185]" : "tw-text-[#f0a050]"}`}>
              {isDown ? "↓" : "↑"} {Math.abs(delta).toFixed(1)}%
            </span>
            <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">{vs[g]}</div>
          </div>
        )}
      </div>
    </div>
  );
}
