import type { Period } from "../lib/periodData";

export function PeriodTabs({ selected, onChange }: { selected: Period; onChange: (p: Period) => void }) {
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pb-2">
      <div className="tw-inline-flex tw-bg-[#1e1e2e] tw-rounded-md tw-p-[3px]">
        {(["today", "day", "week", "month", "year"] as Period[]).map((p) => (
          <button key={p} onClick={() => onChange(p)}
            className={`tw-px-3 tw-py-[3px] tw-text-[10px] tw-font-medium tw-rounded tw-cursor-pointer ${
              selected === p ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]"
                : "tw-text-[var(--vscode-descriptionForeground)]"}`}>{p}</button>
        ))}
      </div>
    </div>
  );
}
