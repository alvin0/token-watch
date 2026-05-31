type SourceOption = "all" | "codex" | "claude";

export function SourceTabs({ selected, onChange }: { selected: SourceOption; onChange: (s: SourceOption) => void }) {
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pb-1.5">
      <div className="tw-inline-flex tw-bg-[#1e1e2e] tw-rounded-md tw-p-[3px]">
        {(["all", "codex", "claude"] as SourceOption[]).map((s) => (
          <button key={s} onClick={() => onChange(s)}
            className={`tw-px-3 tw-py-[3px] tw-text-[10px] tw-font-medium tw-rounded tw-cursor-pointer tw-transition-colors ${
              selected === s
                ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]"
                : "tw-text-[var(--vscode-descriptionForeground)] hover:tw-text-[var(--vscode-foreground)]"
            }`}>
            {s === "all" ? "All" : s === "codex" ? "Codex" : "Claude"}
          </button>
        ))}
      </div>
    </div>
  );
}
