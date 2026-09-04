import { useCallback, useState } from "react";
import type { UsageLimitReset } from "../../shared/protocol";
import { useTranslation } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { useStore } from "../store";
import { formatLimitResetExpiry } from "../limitResets";

/**
 * Confirmation for spending a usage limit reset.
 *
 * Activating one is irreversible and costs a scarce, expiring grant, so this
 * restates exactly which reset is about to go, when it would otherwise expire,
 * and how many would be left — and holds the action behind an explicit
 * acknowledgement rather than a single stray click on a small button.
 */
export function LimitResetConfirmDialog({
  reset,
  availableCount,
  locale,
  onClose,
}: {
  reset: UsageLimitReset;
  availableCount: number;
  locale: string;
  onClose: () => void;
}) {
  const consumeLimitReset = useStore((state) => state.consumeLimitReset);
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string>();
  const requestClose = useCallback(() => {
    if (!activating) { onClose(); }
  }, [onClose, activating]);
  const dialogRef = useModalFocus<HTMLElement>({ open: true, onClose: requestClose });

  const title = reset.title ?? t("quota.limitResetFallbackTitle");
  const expiry = typeof reset.expiresAtUtc === "number" && Number.isFinite(reset.expiresAtUtc)
    ? formatLimitResetExpiry(reset.expiresAtUtc, locale)
    : t("quota.limitResetConfirmNoExpiry");

  const activate = async () => {
    setActivating(true);
    setError(undefined);
    try {
      await consumeLimitReset(reset.id);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("quota.limitResetError"));
    } finally {
      setActivating(false);
    }
  };

  return (
    <div
      className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3 tw-bg-scrim"
      onMouseDown={(event) => {
        if (!activating && event.currentTarget === event.target) { onClose(); }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="limit-reset-confirm-title"
        tabIndex={-1}
        className="tw-flex tw-max-h-full tw-w-full tw-max-w-[420px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-control tw-bg-card tw-shadow-widget tw-outline-none"
      >
        <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-border-b tw-border-edge tw-px-3 tw-py-2.5">
          <div id="limit-reset-confirm-title" className="tw-text-[13px] tw-font-semibold">
            {t("quota.limitResetConfirmTitle")}
          </div>
          <button
            type="button"
            aria-label={t("quota.limitResetConfirmClose")}
            disabled={activating}
            onClick={onClose}
            className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[14px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover disabled:tw-opacity-50"
          >
            ×
          </button>
        </div>

        <div className="tw-min-h-0 tw-flex-1 tw-overflow-y-auto tw-p-3">
          <div className="tw-rounded-md tw-border tw-border-control tw-bg-recessed tw-px-2.5 tw-py-2 tw-text-[10px] tw-leading-relaxed tw-text-[var(--vscode-descriptionForeground)]">
            {t("quota.limitResetConfirmDescription")}
          </div>

          <dl className="tw-mt-2.5 tw-space-y-1.5 tw-text-[11px]">
            <Row label={t("quota.limitResetConfirmReset")} value={title} />
            <Row label={t("quota.limitResetConfirmExpires")} value={expiry} />
            <Row label={t("quota.limitResetConfirmAvailable")} value={String(availableCount)} />
            <Row
              label={t("quota.limitResetConfirmRemaining")}
              value={String(Math.max(0, availableCount - 1))}
            />
          </dl>

          <label className="tw-mt-3 tw-flex tw-cursor-pointer tw-items-start tw-gap-2 tw-text-[10px] tw-leading-relaxed">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={activating}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="tw-mt-0.5 tw-cursor-pointer"
            />
            {t("quota.limitResetConfirmAcknowledge")}
          </label>

          {error && (
            <div role="alert" className="tw-mt-2 tw-text-[10px] tw-text-[var(--vscode-errorForeground,#f06a6a)]">
              {error}
            </div>
          )}
        </div>

        <div className="tw-flex tw-justify-end tw-gap-2 tw-border-t tw-border-edge tw-px-3 tw-py-2.5">
          <button
            type="button"
            disabled={activating}
            onClick={onClose}
            className="tw-cursor-pointer tw-rounded tw-border tw-border-control tw-px-3 tw-py-1.5 tw-text-[11px] hover:tw-bg-hover disabled:tw-opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!acknowledged || activating}
            onClick={() => { void activate(); }}
            className="tw-cursor-pointer tw-rounded tw-bg-[var(--vscode-button-background)] tw-px-3 tw-py-1.5 tw-text-[11px] tw-font-medium tw-text-[var(--vscode-button-foreground)] hover:tw-bg-[var(--vscode-button-hoverBackground)] disabled:tw-cursor-not-allowed disabled:tw-opacity-50"
          >
            {activating ? t("quota.limitResetActivating") : t("quota.limitResetConfirmAction")}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="tw-flex tw-items-baseline tw-justify-between tw-gap-3">
      <dt className="tw-shrink-0 tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{label}</dt>
      <dd className="tw-m-0 tw-min-w-0 tw-truncate tw-text-right tw-font-medium tw-tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}
