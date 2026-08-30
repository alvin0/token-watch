import { useStore } from "../store";
import { useTranslation } from "../i18n";

export function FooterBar() {
  const freshness = useStore((s) => s.freshness);
  const { locale, t } = useTranslation();
  const lastUpdated = freshness.latestRecordUtc ? new Date(freshness.latestRecordUtc).toLocaleTimeString(locale) : "—";
  return (
    <div className="tw-shrink-0 tw-border-t tw-border-edge tw-px-3 tw-py-1.5 tw-flex tw-items-center tw-justify-end tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
      <span className="tw-flex tw-items-center tw-gap-1">{t("footer.updated", { time: lastUpdated })} <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full tw-bg-chart-green" /></span>
    </div>
  );
}
