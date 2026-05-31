import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { formatCost } from "../format";
import { computePeriods } from "../lib/periodData";
import type { Period } from "../lib/periodData";

export function InsightCards() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  if (!result || result.view !== "dashboard") { return null; }
  const { cur, peakLabel } = computePeriods(result.series, g);
  const cacheSaved = (cur.cache / 1000) * (0.005 - 0.0025); // savings = cache * (inputRate - cacheRate)
  const avgTurn = cur.turns > 0 ? cur.cost / cur.turns : 0;

  return (
    <div className="tw-grid tw-grid-cols-2 tw-gap-1.5">
      <MiniCard icon="💰" label="Cache saved" value={formatCost(cacheSaved)} />
      <MiniCard icon="📊" label="Avg / turn" value={formatCost(avgTurn)} />
      <MiniCard icon="🤖" label="Active models" value={String(cur.models)} />
      <MiniCard icon="⚡" label="Peak" value={peakLabel} />
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
