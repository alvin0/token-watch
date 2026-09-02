import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { chartColors } from "../theme";

/**
 * The status line: what the extension is doing on the left, when the newest
 * record it has seen was written on the right.
 *
 * The state dot used to sit next to the title in the header, where "Scanning"
 * competed with the extension's own name for the first thing read. It belongs
 * with the freshness time — both answer how current the numbers are — so the
 * two live together at the bottom of the panel.
 */
export function FooterBar({ status }: { status: string }) {
  const freshness = useStore((s) => s.freshness);
  const { locale, t } = useTranslation();
  const lastUpdated = freshness.latestRecordUtc ? new Date(freshness.latestRecordUtc).toLocaleTimeString(locale) : "—";
  const color = status === "Live"
    ? chartColors.output
    : status === "Scanning" || status === "Stale"
      ? chartColors.cacheRead
      : chartColors.muted;
  const statusLabel = status === "Live" ? t("status.live")
    : status === "Scanning" ? t("status.scanning")
      : status === "Stale" ? t("status.stale")
        : t("status.paused");
  return (
    <div className="tw-shrink-0 tw-border-t tw-border-edge tw-px-3 tw-py-1.5 tw-flex tw-items-center tw-justify-between tw-gap-2 tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
      <span className="tw-flex tw-items-center tw-gap-1" style={{ color }}>
        <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full" style={{ backgroundColor: color }} />{statusLabel}
      </span>
      <span>{t("footer.updated", { time: lastUpdated })}</span>
    </div>
  );
}
