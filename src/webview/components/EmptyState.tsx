import { vscodeApi } from "../store";
import { useTranslation } from "../i18n";

export function EmptyState({ error }: { error?: string }) {
  const { t } = useTranslation();
  return (
    <div className="tw-flex tw-flex-col tw-items-center tw-justify-center tw-h-full tw-gap-2 tw-p-6 tw-text-center">
      <p className="tw-text-[12px]">{error ? t("empty.errorTitle") : t("empty.title")}</p>
      <p className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">
        {error ?? t("empty.description")}
      </p>
      <button onClick={() => vscodeApi.postMessage({ type: "rescan" })}
        className="tw-mt-1 tw-px-3 tw-py-1 tw-text-[10px] tw-rounded tw-bg-[var(--vscode-button-background)] tw-text-[var(--vscode-button-foreground)] tw-cursor-pointer">{t("empty.scan")}</button>
    </div>
  );
}
