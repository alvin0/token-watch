import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CostAlertPeriod, CostAlertRule, CostAlertSource } from "../../shared/protocol";
import { useStore } from "../store";
import { useTranslation } from "../i18n";

interface DraftRule {
  id: string;
  period: CostAlertPeriod;
  source: CostAlertSource;
  budgetUsd: string;
}

export function CostAlertSettingsDialog({ onClose }: { onClose: () => void }) {
  const rules = useStore((state) => state.costAlertRules);
  const loaded = useStore((state) => state.costAlertSettingsLoaded);
  const saveCostAlertRules = useStore((state) => state.saveCostAlertRules);
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<DraftRule[]>(() => toDrafts(rules));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setDrafts(toDrafts(rules));
  }, [rules]);

  useEffect(() => {
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) { onClose(); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  const updateDraft = (id: string, partial: Partial<DraftRule>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...partial } : draft));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSaveError(undefined);
  };

  const removeDraft = (id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSaveError(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const validated = validateDrafts(drafts, t);
    setErrors(validated.errors);
    setSaveError(undefined);
    if (!validated.rules) { return; }

    setSaving(true);
    try {
      await saveCostAlertRules(validated.rules);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("alerts.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3"
      style={{ backgroundColor: "rgba(8, 8, 18, 0.86)" }}
      onMouseDown={(event) => {
        if (!saving && event.currentTarget === event.target) { onClose(); }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cost-threshold-alerts-title"
        tabIndex={-1}
        className="tw-flex tw-max-h-full tw-w-full tw-max-w-[520px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-[#34344a] tw-bg-[#1a1a2e] tw-shadow-2xl tw-outline-none"
      >
        <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-border-b tw-border-[#2a2a3a] tw-px-3 tw-py-2.5">
          <div>
            <div id="cost-threshold-alerts-title" className="tw-text-[13px] tw-font-semibold">{t("header.alerts")}</div>
            <div className="tw-mt-0.5 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">
              {t("alerts.description")}
            </div>
          </div>
          <button
            type="button"
            aria-label={t("alerts.close")}
            disabled={saving}
            onClick={onClose}
            className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[14px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-[#25253a] hover:tw-text-[var(--vscode-foreground)] disabled:tw-cursor-default disabled:tw-opacity-50"
          >
            ×
          </button>
        </div>

        <form onSubmit={save} className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col">
          <div className="tw-min-h-0 tw-flex-1 tw-overflow-y-auto tw-p-3">
            <div className="tw-rounded-md tw-border tw-border-[#34344a] tw-bg-[#141426] tw-px-2.5 tw-py-2 tw-text-[10px] tw-leading-relaxed tw-text-[var(--vscode-descriptionForeground)]">
              {t("alerts.explanation")}
            </div>

            {!loaded ? (
              <div className="tw-py-6 tw-text-center tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)]">{t("alerts.loading")}</div>
            ) : drafts.length === 0 ? (
              <div className="tw-py-6 tw-text-center tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)]">{t("alerts.empty")}</div>
            ) : (
              <div className="tw-mt-2.5 tw-space-y-2">
                {drafts.map((draft, index) => (
                  <div key={draft.id} className="tw-rounded-md tw-border tw-border-[#2a2a3a] tw-bg-[#18182a] tw-p-2.5">
                    <div className="tw-flex tw-items-center tw-justify-between tw-gap-2">
                      <span className="tw-text-[11px] tw-font-medium">{t("alerts.item", { number: index + 1 })}</span>
                      <button
                        type="button"
                        aria-label={t("alerts.delete", { number: index + 1 })}
                        disabled={saving}
                        onClick={() => removeDraft(draft.id)}
                        className="tw-cursor-pointer tw-rounded tw-px-1.5 tw-py-0.5 tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-[#2a2030] hover:tw-text-[#f06a6a] disabled:tw-cursor-default disabled:tw-opacity-50"
                      >
                        ×
                      </button>
                    </div>
                    <div className="tw-mt-2 tw-grid tw-grid-cols-3 tw-gap-2">
                      <label className="tw-flex tw-flex-col tw-gap-1 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">
                        {t("alerts.period")}
                        <select
                          value={draft.period}
                          disabled={saving}
                          onChange={(event) => updateDraft(draft.id, { period: event.target.value as CostAlertPeriod })}
                          className="tw-h-7 tw-rounded tw-border tw-border-[var(--vscode-dropdown-border,#3c3c4f)] tw-bg-[var(--vscode-dropdown-background,#222236)] tw-px-2 tw-text-[11px] tw-text-[var(--vscode-dropdown-foreground,var(--vscode-foreground))] tw-outline-none focus:tw-border-[var(--vscode-focusBorder)]"
                        >
                          <option value="day">{t("alerts.daily")}</option>
                          <option value="week">{t("alerts.weekly")}</option>
                          <option value="month">{t("alerts.monthly")}</option>
                        </select>
                      </label>
                      <label className="tw-flex tw-flex-col tw-gap-1 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">
                        {t("alerts.source")}
                        <select
                          value={draft.source}
                          disabled={saving}
                          onChange={(event) => updateDraft(draft.id, { source: event.target.value as CostAlertSource })}
                          className="tw-h-7 tw-rounded tw-border tw-border-[var(--vscode-dropdown-border,#3c3c4f)] tw-bg-[var(--vscode-dropdown-background,#222236)] tw-px-2 tw-text-[11px] tw-text-[var(--vscode-dropdown-foreground,var(--vscode-foreground))] tw-outline-none focus:tw-border-[var(--vscode-focusBorder)]"
                        >
                          <option value="all">{t("alerts.sourceAll")}</option>
                          <option value="codex">{t("alerts.sourceCodex")}</option>
                          <option value="claude">{t("alerts.sourceClaude")}</option>
                        </select>
                      </label>
                      <label className="tw-flex tw-flex-col tw-gap-1 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">
                        {t("alerts.budget")}
                        <span className="tw-flex tw-h-7 tw-items-center tw-rounded tw-border tw-border-[var(--vscode-input-border,#3c3c4f)] tw-bg-[var(--vscode-input-background,#222236)] tw-px-2 focus-within:tw-border-[var(--vscode-focusBorder)]">
                          <span className="tw-mr-1 tw-text-[11px]">$</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            inputMode="decimal"
                            value={draft.budgetUsd}
                            disabled={saving}
                            aria-invalid={Boolean(errors[draft.id])}
                            onChange={(event) => updateDraft(draft.id, { budgetUsd: event.target.value })}
                            className="tw-min-w-0 tw-flex-1 tw-bg-transparent tw-text-[11px] tw-text-[var(--vscode-input-foreground,var(--vscode-foreground))] tw-outline-none"
                            placeholder="25.00"
                          />
                        </span>
                      </label>
                    </div>
                    {errors[draft.id] && <div className="tw-mt-1.5 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">{errors[draft.id]}</div>}
                  </div>
                ))}
              </div>
            )}

            {loaded && (
              <button
                type="button"
                disabled={saving}
                onClick={() => setDrafts((current) => [...current, newDraft()])}
                className="tw-mt-2.5 tw-w-full tw-cursor-pointer tw-rounded tw-border tw-border-dashed tw-border-[#3a3a50] tw-px-2 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-bg-[#202035] disabled:tw-cursor-default disabled:tw-opacity-50"
              >
                {t("alerts.add")}
              </button>
            )}

            {saveError && <div role="alert" className="tw-mt-2 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">{saveError}</div>}
          </div>

          <div className="tw-flex tw-justify-end tw-gap-2 tw-border-t tw-border-[#2a2a3a] tw-px-3 tw-py-2.5">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="tw-cursor-pointer tw-rounded tw-border tw-border-[#3a3a50] tw-px-3 tw-py-1.5 tw-text-[11px] hover:tw-bg-[#25253a] disabled:tw-cursor-default disabled:tw-opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={!loaded || saving}
              className="tw-cursor-pointer tw-rounded tw-bg-[var(--vscode-button-background)] tw-px-3 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-button-foreground)] hover:tw-bg-[var(--vscode-button-hoverBackground)] disabled:tw-cursor-default disabled:tw-opacity-50"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function toDrafts(rules: CostAlertRule[]): DraftRule[] {
  return rules.map((rule) => ({ ...rule, source: rule.source ?? "all", budgetUsd: String(rule.budgetUsd) }));
}

function newDraft(): DraftRule {
  return { id: crypto.randomUUID(), period: "day", source: "all", budgetUsd: "" };
}

function validateDrafts(
  drafts: DraftRule[],
  t: ReturnType<typeof useTranslation>["t"],
): { rules?: CostAlertRule[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const rules: CostAlertRule[] = [];
  const seen = new Map<string, string>();

  for (const draft of drafts) {
    const budgetUsd = Number(draft.budgetUsd);
    if (!draft.budgetUsd.trim() || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      errors[draft.id] = t("alerts.invalidBudget");
      continue;
    }
    const duplicateKey = `${draft.source}:${draft.period}:${budgetUsd}`;
    const duplicateId = seen.get(duplicateKey);
    if (duplicateId) {
      errors[draft.id] = t("alerts.duplicate");
      errors[duplicateId] = t("alerts.duplicate");
      continue;
    }
    seen.set(duplicateKey, draft.id);
    rules.push({ id: draft.id, period: draft.period, source: draft.source, budgetUsd });
  }

  return Object.keys(errors).length > 0 ? { errors } : { rules, errors };
}
