import { useRef, useState } from "react";
import { useStore, vscodeApi } from "../store";
import { CostAlertSettingsDialog } from "./CostAlertSettingsDialog";
import { PricingSettingsDialog } from "./PricingSettingsDialog";
import { useTranslation } from "../i18n";
import type { AppLanguage } from "../../shared/i18n";

export function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const alertButtonRef = useRef<HTMLButtonElement>(null);
  const pricingButtonRef = useRef<HTMLButtonElement>(null);
  const setLanguage = useStore((state) => state.setLanguage);
  const { language, t } = useTranslation();
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => alertButtonRef.current?.focus());
  };
  return (
    <>
      <div className="tw-shrink-0 tw-px-3 tw-pt-2 tw-pb-1 tw-flex tw-items-center tw-gap-2">
        <span className="tw-text-[13px] tw-font-bold tw-text-[var(--vscode-foreground)]">Token Watch</span>
        <div className="tw-ml-auto tw-flex tw-items-center tw-gap-0.5">
          <button
            type="button"
            title={t("header.rescan")}
            aria-label={t("header.rescan")}
            onClick={() => vscodeApi.postMessage({ type: "rescan" })}
            className="tw-flex tw-h-6 tw-w-6 tw-cursor-pointer tw-items-center tw-justify-center tw-rounded tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
          >
            &#8635;
          </button>
          <select
            value={language}
            title={t("language.label")}
            aria-label={t("language.label")}
            onChange={(event) => setLanguage(event.target.value as AppLanguage)}
            className="tw-h-6 tw-cursor-pointer tw-rounded tw-border tw-border-control tw-bg-[var(--vscode-dropdown-background,#222236)] tw-px-1 tw-text-[8px] tw-font-medium tw-text-[var(--vscode-dropdown-foreground,var(--vscode-foreground))] tw-outline-none focus:tw-border-[var(--vscode-focusBorder)]"
          >
            <option value="en">EN</option>
            <option value="vi">VI</option>
            <option value="ja">JA</option>
          </select>
          <button
            ref={pricingButtonRef}
            type="button"
            title={t("pricing.title")}
            aria-label={t("pricing.title")}
            aria-haspopup="dialog"
            onClick={() => setPricingOpen(true)}
            className="tw-flex tw-h-6 tw-w-6 tw-cursor-pointer tw-items-center tw-justify-center tw-rounded tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="tw-h-3.5 tw-w-3.5 tw-fill-none tw-stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.3 7 6s1.8 2.6 5 3.5 5 1.8 5 4.5-2.2 4-5 4-5-1.6-5-3.5" />
            </svg>
          </button>
          <button
            ref={alertButtonRef}
            type="button"
            title={t("header.alerts")}
            aria-label={t("header.alerts")}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
            className="tw-flex tw-h-6 tw-w-6 tw-cursor-pointer tw-items-center tw-justify-center tw-rounded tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="tw-h-3.5 tw-w-3.5 tw-fill-none tw-stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
              <path d="M10 21h4" />
            </svg>
          </button>
        </div>
      </div>
      {settingsOpen && <CostAlertSettingsDialog onClose={closeSettings} />}
      {pricingOpen && <PricingSettingsDialog onClose={() => {
        setPricingOpen(false);
        requestAnimationFrame(() => pricingButtonRef.current?.focus());
      }} />}
    </>
  );
}
