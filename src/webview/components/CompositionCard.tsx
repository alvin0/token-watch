import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";

export function CompositionCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  if (!result || result.view !== "dashboard") { return null; }
  const { cur } = computePeriods(result.series, g);
  const { input, output, cache, reasoning } = cur;
  const total = input + output + cache + reasoning;
  if (total === 0) { return null; }

  const cachePct = cache / total;
  const insight = cachePct > 0.5 ? "High cache usage reduced total cost."
    : cachePct < 0.1 ? "Low cache usage may increase cost."
    : reasoning / total > 0.1 ? "Reasoning tokens are unusually high."
    : "Balanced token distribution.";

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-text-[10px] tw-font-medium tw-mb-1.5">Token composition</div>
      <div className="tw-flex tw-h-[6px] tw-rounded-full tw-overflow-hidden tw-mb-2">
        {input > 0 && <div style={{ flex: input, backgroundColor: "#4fc1ff" }} />}
        {output > 0 && <div style={{ flex: output, backgroundColor: "#cca700" }} />}
        {cache > 0 && <div style={{ flex: cache, backgroundColor: "#50c8a8" }} />}
        {reasoning > 0 && <div style={{ flex: reasoning, backgroundColor: "#b180d7" }} />}
      </div>
      <div className="tw-flex tw-justify-between tw-text-[9px]">
        <Dot color="#4fc1ff" label="Input" value={fmtT(input)} />
        <Dot color="#cca700" label="Output" value={fmtT(output)} />
        <Dot color="#50c8a8" label="Cache" value={fmtT(cache)} />
        <Dot color="#b180d7" label="Reasoning" value={fmtT(reasoning)} />
      </div>
      <div className="tw-mt-1.5 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)] tw-flex tw-items-center tw-gap-1">
        <span className="tw-text-[#89d185]">✓</span>{insight}
      </div>
    </div>
  );
}

function Dot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="tw-text-center">
      <div className="tw-flex tw-items-center tw-justify-center tw-gap-0.5">
        <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full" style={{ backgroundColor: color }} />
        <span className="tw-text-[var(--vscode-descriptionForeground)]">{label}</span>
      </div>
      <div className="tw-font-semibold tw-text-[var(--vscode-foreground)] tw-tabular-nums">{value}</div>
    </div>
  );
}
