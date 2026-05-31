import { useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { pRange, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";

export function TopModelsCard() {
  const [showAll, setShowAll] = useState(false);
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  if (!result || result.view !== "dashboard") { return null; }
  const { from } = pRange(g);
  const filtered = result.series.filter((r) => r.day >= from);
  const mMap = new Map<string, { input: number; output: number; cache: number; reasoning: number; turns: number }>();
  for (const r of filtered) {
    const m = mMap.get(r.variantId) ?? { input: 0, output: 0, cache: 0, reasoning: 0, turns: 0 };
    m.input += r.inputTokens; m.output += r.outputTokens; m.cache += r.cacheReadTokens; m.reasoning += r.reasoningTokens; m.turns += r.turns;
    mMap.set(r.variantId, m);
  }
  const allModels = Array.from(mMap.entries()).map(([id, m]) => ({ id, total: m.input + m.output + m.cache + m.reasoning, ...m })).sort((a, b) => b.total - a.total);
  const totalAll = allModels.reduce((s, m) => s + m.total, 0);
  const models = showAll ? allModels : allModels.slice(0, 5);
  if (allModels.length === 0) { return null; }

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">Top models</span>
        <span className="tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">{allModels.length} models</span>
      </div>
      <div className="tw-space-y-1.5">
        {models.map((m) => {
          const pct = totalAll > 0 ? (m.total / totalAll) * 100 : 0;
          return (
            <div key={m.id} className="tw-flex tw-items-center tw-gap-2">
              <span className="tw-text-[9px] tw-w-[110px] tw-truncate tw-shrink-0 tw-text-[var(--vscode-foreground)]" title={m.id}>{m.id}</span>
              <div className="tw-flex-1 tw-flex tw-h-[6px] tw-rounded-sm tw-overflow-hidden">
                <div style={{ flex: m.input, backgroundColor: "#4fc1ff" }} />
                <div style={{ flex: m.output, backgroundColor: "#cca700" }} />
                <div style={{ flex: m.cache, backgroundColor: "#50c8a8" }} />
                <div style={{ flex: m.reasoning, backgroundColor: "#b180d7" }} />
              </div>
              <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)] tw-tabular-nums tw-w-[38px] tw-text-right">{fmtT(m.total)}</span>
              <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)] tw-tabular-nums tw-w-[40px] tw-text-right">{m.turns} turns</span>
              <span className="tw-text-[9px] tw-font-medium tw-text-[#50c8a8] tw-tabular-nums tw-w-[32px] tw-text-right">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
      {allModels.length > 5 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="tw-mt-2 tw-text-[9px] tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline tw-cursor-pointer"
        >
          {showAll ? "Show less" : `Show all ${allModels.length} models`}
        </button>
      )}
    </div>
  );
}
