import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ModelRate, PricingTable } from "../../shared/types";
import { useTranslation } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStore } from "../store";

type RateKey = keyof ModelRate;

interface DraftRate {
  id: string;
  model: string;
  inputPer1K: string;
  cachedInputPer1K: string;
  cacheCreationPer1K: string;
  outputPer1K: string;
}

const RATE_FIELDS: Array<{ key: RateKey; label: "pricing.input" | "pricing.cacheRead" | "pricing.cacheWrite" | "pricing.output"; required?: boolean }> = [
  { key: "inputPer1K", label: "pricing.input", required: true },
  { key: "cachedInputPer1K", label: "pricing.cacheRead" },
  { key: "cacheCreationPer1K", label: "pricing.cacheWrite" },
  { key: "outputPer1K", label: "pricing.output", required: true },
];

export function PricingSettingsDialog({ onClose }: { onClose: () => void }) {
  const table = useStore((state) => state.pricingTable);
  const loaded = useStore((state) => state.pricingSettingsLoaded);
  const savePricingTable = useStore((state) => state.savePricingTable);
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState(() => toDrafts(table));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const requestClose = useCallback(() => {
    if (!saving) { onClose(); }
  }, [onClose, saving]);
  // Traps Tab inside the dialog and restores focus to the opener on close.
  const dialogRef = useModalFocus<HTMLElement>({ open: true, onClose: requestClose });

  useEffect(() => setDrafts(toDrafts(table)), [table]);

  const updateDraft = (id: string, partial: Partial<DraftRate>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...partial } : draft));
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
    if (!validated.table) { return; }
    setSaving(true);
    try {
      await savePricingTable(validated.table);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("pricing.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3 tw-bg-scrim" onMouseDown={(event) => {
      if (!saving && event.currentTarget === event.target) { onClose(); }
    }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="custom-pricing-title" tabIndex={-1} className="tw-flex tw-max-h-full tw-w-full tw-max-w-[560px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-control tw-bg-card tw-shadow-widget tw-outline-none">
        <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-border-b tw-border-edge tw-px-3 tw-py-2.5">
          <div>
            <div id="custom-pricing-title" className="tw-text-[13px] tw-font-semibold">{t("pricing.title")}</div>
            <div className="tw-mt-0.5 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{t("pricing.description")}</div>
          </div>
          <button type="button" aria-label={t("pricing.close")} disabled={saving} onClick={onClose} className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[14px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover disabled:tw-opacity-50">×</button>
        </div>

        <form onSubmit={save} className="tw-flex tw-min-h-0 tw-flex-1 tw-flex-col">
          <div className="tw-min-h-0 tw-flex-1 tw-overflow-y-auto tw-p-3">
            <div className="tw-rounded-md tw-border tw-border-control tw-bg-recessed tw-px-2.5 tw-py-2 tw-text-[10px] tw-leading-relaxed tw-text-[var(--vscode-descriptionForeground)]">{t("pricing.explanation")}</div>
            {!loaded ? (
              <div className="tw-py-6 tw-text-center tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)]">{t("pricing.loading")}</div>
            ) : drafts.length === 0 ? (
              <div className="tw-py-6 tw-text-center tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)]">{t("pricing.empty")}</div>
            ) : (
              <div className="tw-mt-2.5 tw-space-y-2">
                {drafts.map((draft, index) => (
                  <div key={draft.id} className="tw-rounded-md tw-border tw-border-edge tw-bg-recessed tw-p-2.5">
                    <div className="tw-flex tw-items-center tw-gap-2">
                      <input value={draft.model} disabled={saving} aria-label={t("pricing.modelId")} aria-invalid={Boolean(errors[draft.id])} onChange={(event) => updateDraft(draft.id, { model: event.target.value })} className="tw-h-7 tw-min-w-0 tw-flex-1 tw-rounded tw-border tw-border-[var(--vscode-input-border,#3c3c4f)] tw-bg-[var(--vscode-input-background,#222236)] tw-px-2 tw-text-[11px] tw-outline-none focus:tw-border-[var(--vscode-focusBorder)]" placeholder={t("pricing.modelPlaceholder")} />
                      <button type="button" aria-label={t("pricing.delete", { number: index + 1 })} disabled={saving} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))} className="tw-cursor-pointer tw-rounded tw-px-1.5 tw-py-0.5 tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-danger-bg hover:tw-text-chart-red disabled:tw-opacity-50">×</button>
                    </div>
                    <div className="tw-mt-2 tw-grid tw-grid-cols-2 tw-gap-2">
                      {RATE_FIELDS.map((field) => (
                        <label key={field.key} className="tw-flex tw-flex-col tw-gap-1 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
                          {t(field.label)}{field.required ? " *" : ""}
                          <input type="number" min="0" step="any" inputMode="decimal" value={draft[field.key]} disabled={saving} onChange={(event) => updateDraft(draft.id, { [field.key]: event.target.value })} className="tw-h-7 tw-min-w-0 tw-rounded tw-border tw-border-[var(--vscode-input-border,#3c3c4f)] tw-bg-[var(--vscode-input-background,#222236)] tw-px-2 tw-text-[11px] tw-outline-none focus:tw-border-[var(--vscode-focusBorder)]" placeholder="0.00" />
                        </label>
                      ))}
                    </div>
                    {errors[draft.id] && <div className="tw-mt-1.5 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">{errors[draft.id]}</div>}
                  </div>
                ))}
              </div>
            )}
            {loaded && <button type="button" disabled={saving} onClick={() => setDrafts((current) => [...current, newDraft()])} className="tw-mt-2.5 tw-w-full tw-cursor-pointer tw-rounded tw-border tw-border-dashed tw-border-control tw-px-2 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-bg-hover disabled:tw-opacity-50">{t("pricing.add")}</button>}
            {saveError && <div role="alert" className="tw-mt-2 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">{saveError}</div>}
          </div>
          <div className="tw-flex tw-justify-end tw-gap-2 tw-border-t tw-border-edge tw-px-3 tw-py-2.5">
            <button type="button" disabled={saving} onClick={onClose} className="tw-cursor-pointer tw-rounded tw-border tw-border-control tw-px-3 tw-py-1.5 tw-text-[11px] hover:tw-bg-hover disabled:tw-opacity-50">{t("common.cancel")}</button>
            <button type="submit" disabled={!loaded || saving} className="tw-cursor-pointer tw-rounded tw-bg-[var(--vscode-button-background)] tw-px-3 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-button-foreground)] hover:tw-bg-[var(--vscode-button-hoverBackground)] disabled:tw-opacity-50">{saving ? t("common.saving") : t("common.save")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function newDraft(): DraftRate {
  return { id: crypto.randomUUID(), model: "", inputPer1K: "", cachedInputPer1K: "", cacheCreationPer1K: "", outputPer1K: "" };
}

function toDrafts(table: PricingTable): DraftRate[] {
  return Object.entries(table).sort(([a], [b]) => a.localeCompare(b)).map(([model, rate]) => ({
    id: crypto.randomUUID(),
    model,
    inputPer1K: perMillionValue(rate.inputPer1K),
    cachedInputPer1K: perMillionValue(rate.cachedInputPer1K),
    cacheCreationPer1K: perMillionValue(rate.cacheCreationPer1K),
    outputPer1K: perMillionValue(rate.outputPer1K),
  }));
}

function perMillionValue(per1K: number | undefined): string {
  return per1K === undefined ? "" : String(per1K * 1000);
}

function validateDrafts(drafts: DraftRate[], t: ReturnType<typeof useTranslation>["t"]): { table?: PricingTable; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const table: PricingTable = {};
  const seen = new Map<string, string>();
  for (const draft of drafts) {
    const model = draft.model.trim();
    if (!model || model.startsWith("$")) {
      errors[draft.id] = t("pricing.invalidModel");
      continue;
    }
    const duplicateId = seen.get(model);
    if (duplicateId) {
      errors[draft.id] = t("pricing.duplicate");
      errors[duplicateId] = t("pricing.duplicate");
      continue;
    }
    const rate: ModelRate = {};
    let invalidRate = false;
    for (const field of RATE_FIELDS) {
      const raw = draft[field.key].trim();
      if (!raw) {
        if (field.required) { invalidRate = true; }
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        invalidRate = true;
        continue;
      }
      rate[field.key] = value / 1000;
    }
    if (invalidRate) {
      errors[draft.id] = t("pricing.invalidRate");
      continue;
    }
    seen.set(model, draft.id);
    table[model] = rate;
  }
  return Object.keys(errors).length ? { errors } : { table, errors };
}
