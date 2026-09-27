import { useCallback, useState, type FormEvent } from "react";
import { defaultTabLayout, type CardSlot, type LayoutTab } from "../../shared/cardLayout";
import type { TranslationKey } from "../../shared/i18n";
import { useTranslation } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStore } from "../store";

const TAB_LABEL: Record<LayoutTab, TranslationKey> = {
  today: "common.today",
  day: "common.day",
  week: "common.week",
  month: "common.month",
  year: "common.year",
};

/**
 * Show, hide and reorder the cards of one period tab.
 *
 * Edits the tab being looked at, so what changes is what is on screen behind
 * the dialog; the other tabs keep their own layouts. Nothing is written until
 * Save, so trying an order out does not rewrite settings.json on every click.
 */
export function CardLayoutDialog({ tab, onClose }: { tab: LayoutTab; onClose: () => void }) {
  const layout = useStore((state) => state.cardLayout);
  const saveCardLayout = useStore((state) => state.saveCardLayout);
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CardSlot[]>(() => layout[tab]);
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const requestClose = useCallback(() => {
    if (!saving) { onClose(); }
  }, [onClose, saving]);
  // Traps Tab inside the dialog and restores focus to the opener on close.
  const dialogRef = useModalFocus<HTMLElement>({ open: true, onClose: requestClose });

  const move = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
    setSaveError(undefined);
  };

  const toggle = (index: number) => {
    setDraft((current) => current.map((slot, i) => i === index ? { ...slot, visible: !slot.visible } : slot));
    setSaveError(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveCardLayout({ ...layout, [tab]: draft });
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("layout.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const arrowClass = "tw-cursor-pointer tw-rounded tw-px-1.5 tw-py-0.5 tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)] disabled:tw-cursor-not-allowed disabled:tw-opacity-30";

  return (
    <div className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3 tw-bg-scrim" onMouseDown={(event) => {
      if (!saving && event.currentTarget === event.target) { onClose(); }
    }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="card-layout-title" tabIndex={-1} className="tw-flex tw-max-h-full tw-w-full tw-max-w-[420px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-control tw-bg-card tw-shadow-widget tw-outline-none">
        <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-border-b tw-border-edge tw-px-3 tw-py-2.5">
          <div>
            <div id="card-layout-title" className="tw-text-[13px] tw-font-semibold">{t("layout.title", { tab: t(TAB_LABEL[tab]) })}</div>
            <div className="tw-mt-0.5 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{t("layout.description")}</div>
          </div>
          <button type="button" aria-label={t("layout.close")} disabled={saving} onClick={onClose} className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[14px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover disabled:tw-opacity-50">×</button>
        </div>

        <form onSubmit={save} className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col">
          <div className="tw-min-h-0 tw-flex-1 tw-overflow-y-auto tw-p-3">
            <ul className="tw-space-y-1.5">
              {draft.map((slot, index) => {
                const name = t(`layout.card.${slot.id}` as TranslationKey);
                return (
                  <li key={slot.id} className="tw-flex tw-items-center tw-gap-2 tw-rounded-md tw-border tw-border-edge tw-bg-recessed tw-px-2.5 tw-py-1.5">
                    <label className={`tw-flex tw-min-w-0 tw-flex-1 tw-cursor-pointer tw-items-center tw-gap-2 tw-text-[11px] ${slot.visible ? "" : "tw-text-[var(--vscode-descriptionForeground)]"}`}>
                      <input type="checkbox" checked={slot.visible} disabled={saving} onChange={() => toggle(index)} className="tw-cursor-pointer" />
                      <span className="tw-truncate">{name}</span>
                    </label>
                    <button type="button" aria-label={t("layout.moveUp", { card: name })} disabled={saving || index === 0} onClick={() => move(index, -1)} className={arrowClass}>↑</button>
                    <button type="button" aria-label={t("layout.moveDown", { card: name })} disabled={saving || index === draft.length - 1} onClick={() => move(index, 1)} className={arrowClass}>↓</button>
                  </li>
                );
              })}
            </ul>
            {saveError && <div role="alert" className="tw-mt-2 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">{saveError}</div>}
          </div>
          <div className="tw-flex tw-items-center tw-gap-2 tw-border-t tw-border-edge tw-px-3 tw-py-2.5">
            <button type="button" disabled={saving} onClick={() => { setDraft(defaultTabLayout(tab)); setSaveError(undefined); }} className="tw-mr-auto tw-cursor-pointer tw-rounded tw-px-2 tw-py-1.5 tw-text-[11px] tw-text-[var(--vscode-textLink-foreground)] hover:tw-bg-hover disabled:tw-opacity-50">{t("layout.reset")}</button>
            <button type="button" disabled={saving} onClick={onClose} className="tw-cursor-pointer tw-rounded tw-border tw-border-control tw-px-3 tw-py-1.5 tw-text-[11px] hover:tw-bg-hover disabled:tw-opacity-50">{t("common.cancel")}</button>
            <button type="submit" disabled={saving} className="tw-cursor-pointer tw-rounded tw-bg-[var(--vscode-button-background)] tw-px-3 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-button-foreground)] hover:tw-bg-[var(--vscode-button-hoverBackground)] disabled:tw-opacity-50">{saving ? t("common.saving") : t("common.save")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
