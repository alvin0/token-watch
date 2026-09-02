import { useTranslation } from "../i18n";
import { useRovingKeys } from "../hooks/useRovingKeys";

type SourceOption = "all" | "codex" | "claude";

const SOURCE_ORDER: SourceOption[] = ["all", "codex", "claude"];

export function SourceTabs({ selected, onChange }: { selected: SourceOption; onChange: (s: SourceOption) => void }) {
  const { t } = useTranslation();
  const onKeyDown = useRovingKeys(SOURCE_ORDER, selected, onChange);
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pb-1.5">
      <div
        role="tablist"
        aria-label={t("common.source")}
        onKeyDown={onKeyDown}
        className="tw-inline-flex tw-bg-track tw-rounded-md tw-p-[3px]"
      >
        {SOURCE_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={selected === s}
            tabIndex={selected === s ? 0 : -1}
            onClick={() => onChange(s)}
            className={`tw-px-3 tw-py-[3px] tw-text-[10px] tw-font-medium tw-rounded tw-cursor-pointer tw-transition-colors ${
              selected === s
                ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]"
                : "tw-text-[var(--vscode-descriptionForeground)] hover:tw-text-[var(--vscode-foreground)]"
            }`}>
            {s === "all" ? t("common.all") : s === "codex" ? "Codex" : "Claude"}
          </button>
        ))}
      </div>
    </div>
  );
}
