import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";
import { useRovingKeys } from "../hooks/useRovingKeys";

const PERIOD_ORDER: Period[] = ["today", "day", "week", "month", "year"];

export function PeriodTabs({ selected, onChange }: { selected: Period; onChange: (p: Period) => void }) {
  const { t } = useTranslation();
  const onKeyDown = useRovingKeys(PERIOD_ORDER, selected, onChange);
  const labels = {
    today: t("common.today"), day: t("common.day"), week: t("common.week"),
    month: t("common.month"), year: t("common.year"),
  };
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pb-2">
      <div
        role="tablist"
        aria-label={t("common.period")}
        onKeyDown={onKeyDown}
        className="tw-inline-flex tw-bg-track tw-rounded-md tw-p-[3px]"
      >
        {PERIOD_ORDER.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={selected === p}
            tabIndex={selected === p ? 0 : -1}
            onClick={() => onChange(p)}
            className={`tw-px-3 tw-py-[3px] tw-text-[10px] tw-font-medium tw-rounded tw-cursor-pointer ${
              selected === p ? "tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)]"
                : "tw-text-[var(--vscode-descriptionForeground)]"}`}>{labels[p]}</button>
        ))}
      </div>
    </div>
  );
}
