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
  const labels: Record<Period, string> = { day: `Today cost${sourceLabel}`, week: `This week cost${sourceLabel}`, month: `This month cost${sourceLabel}`, year: `This year cost${sourceLabel}` };
  const vs: Record<Period, string> = { day: "vs yesterday", week: "vs prev week", month: "vs prev month", year: "vs prev year" };

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-start tw-justify-between">
        <div>
          <div className="tw-text-[22px] tw-font-bold tw-tabular-nums tw-text-[var(--vscode-foreground)]">{formatCost(cur.cost)}</div>
          <div className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{labels[g]}</div>
          <div className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)] tw-mt-0.5">
            {fmtT(cur.tokens)} tokens • {cur.turns.toLocaleString()} turns
            {g !== "day" && <span> • {cur.activeDays} day{cur.activeDays !== 1 ? "s" : ""} active</span>}
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
