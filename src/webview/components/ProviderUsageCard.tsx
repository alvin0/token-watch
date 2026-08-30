import { useEffect, useState } from "react";
import { formatPercent, LIMIT_RESET_EXPIRY_WARNING_MS } from "../../shared/codexUsage";
import type {
  UsageCacheInfo,
  UsageLimitReset,
  UsageLimitResetsInfo,
  UsagePlanInfo,
  UsageQuotaWindow,
} from "../../shared/protocol";
import {
  buildProviderQuotaLayout,
  quotaWindowLabel,
  type QuotaProvider,
} from "../quotaGroups";
import { vscodeApi } from "../store";
import { formatUsageTime } from "../usageCacheDisplay";
import { useTranslation } from "../i18n";

const TWO_COLUMN_GRID = { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" };

export function ProviderUsageCard({
  provider,
  title,
  windows,
  cacheInfo,
  plan,
  limitResets,
}: {
  provider: QuotaProvider;
  title: string;
  windows: UsageQuotaWindow[];
  cacheInfo?: UsageCacheInfo;
  plan?: UsagePlanInfo;
  limitResets?: UsageLimitResetsInfo;
}) {
  const [expanded, setExpanded] = useState(false);
  const [, refreshRetryState] = useState(0);
  const { locale, t } = useTranslation();
  const layout = buildProviderQuotaLayout(provider, windows);

  useEffect(() => {
    const retryAt = cacheInfo?.retryAtUtc;
    if (!retryAt) { return; }
    const delay = retryAt - Date.now();
    if (delay <= 0) { return; }
    const timer = window.setTimeout(() => refreshRetryState((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [cacheInfo?.retryAtUtc]);

  if (layout.primaryWindows.length === 0 && layout.additionalLimitCount === 0 && !cacheInfo) {
    return null;
  }

  const hasAdditional = layout.additionalLimitCount > 0;
  const collapsedSummary = layout.additionalGroups.length === 1
    ? t(layout.additionalLimitCount === 1 ? "quota.additionalOne" : "quota.additionalMany", {
      name: layout.additionalGroups[0].name,
      count: layout.additionalLimitCount,
    })
    : t("quota.additionalTotal", { count: layout.additionalLimitCount });
  const cachedLabel = formatUsageTime(t("quota.cachedAt"), cacheInfo?.cachedAtUtc, locale);
  const retryAtLabel = formatUsageTime(t("quota.retryAt"), cacheInfo?.retryAtUtc, locale);
  const retryWaiting = Boolean(cacheInfo?.retryAtUtc && cacheInfo.retryAtUtc > Date.now());
  const retryDisabled = Boolean(cacheInfo?.refreshing) || retryWaiting;
  const retryLabel = cacheInfo?.refreshing
    ? t("common.refreshing")
    : retryWaiting
      ? retryAtLabel
      : t("common.retry");
  const unavailable = Boolean(
    cacheInfo?.unavailable
    && layout.primaryWindows.length === 0
    && layout.additionalLimitCount === 0,
  );

  if (unavailable) {
    return (
      <section className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-px-3 tw-py-2.5">
        <div className="tw-flex tw-min-w-0 tw-items-center tw-gap-1.5">
          <span className="tw-min-w-0 tw-truncate tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">
            {title}
          </span>
          <PlanBadge plan={plan} />
        </div>
        <div className="tw-flex tw-shrink-0 tw-items-center tw-gap-2">
          <div className="tw-flex tw-items-center tw-gap-1.5 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
            <span className="tw-h-1.5 tw-w-1.5 tw-rounded-full tw-bg-[var(--vscode-descriptionForeground)]" />
            {t("common.unavailable")}
          </div>
          <button
            type="button"
            disabled={retryDisabled}
            onClick={() => vscodeApi.postMessage({ type: "refreshUsage", provider })}
            className="tw-rounded tw-border tw-border-control tw-px-2 tw-py-0.5 tw-text-[8px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] enabled:tw-cursor-pointer enabled:hover:tw-bg-hover disabled:tw-cursor-not-allowed disabled:tw-opacity-50"
          >
            {retryLabel}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-edge tw-bg-card">
      <div className="tw-p-3">
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3">
          <div className="tw-flex tw-min-w-0 tw-items-center tw-gap-1.5">
            <span className="tw-min-w-0 tw-truncate tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">
              {title}
            </span>
            <PlanBadge plan={plan} />
          </div>
          <div className="tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-text-[9px] tw-text-chart-green">
            <span className="tw-h-1.5 tw-w-1.5 tw-rounded-full tw-bg-chart-green" />
            {t("common.active")}
          </div>
        </div>

        {layout.primaryWindows.length > 0 && (
          <div className="tw-mt-2 tw-grid tw-gap-x-3 tw-gap-y-1.5" style={TWO_COLUMN_GRID}>
            {layout.primaryWindows.map((window) => (
              <CompactQuota key={window.id} window={window} locale={locale} />
            ))}
          </div>
        )}

        <LimitResets limitResets={limitResets} locale={locale} />

        {cacheInfo && (
          <div className="tw-mt-2 tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-edge tw-pt-2">
            <span className="tw-min-w-0 tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
              {cachedLabel ?? (cacheInfo.refreshing ? t("quota.fetching") : t("quota.noCache"))}
            </span>
            <button
              type="button"
              disabled={retryDisabled}
              onClick={() => vscodeApi.postMessage({ type: "refreshUsage", provider })}
              className="tw-shrink-0 tw-rounded tw-border tw-border-control tw-px-2 tw-py-0.5 tw-text-[8px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] enabled:tw-cursor-pointer enabled:hover:tw-bg-hover disabled:tw-cursor-not-allowed disabled:tw-opacity-50"
            >
              {retryLabel}
            </button>
          </div>
        )}
      </div>

      {expanded && layout.additionalGroups.map((group) => (
        <div key={group.id} className="tw-border-t tw-border-edge tw-p-3">
          <div className="tw-truncate tw-text-[9px] tw-font-medium tw-uppercase tw-text-[var(--vscode-foreground)]" title={group.name}>
            {group.name}
          </div>
          <div className="tw-mt-2 tw-grid tw-gap-x-3 tw-gap-y-1.5" style={TWO_COLUMN_GRID}>
            {group.windows.map((window) => (
              <CompactQuota key={window.id} window={window} locale={locale} showUnavailableReset />
            ))}
          </div>
        </div>
      ))}

      {hasAdditional && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-edge tw-bg-recessed tw-px-3 tw-py-2 tw-text-left hover:tw-bg-hover"
        >
          <span className="tw-min-w-0 tw-truncate tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
            {expanded ? "" : collapsedSummary}
          </span>
          <span className="tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)]">
            {expanded ? t("common.showLess") : t("common.showMore")}
            <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
          </span>
        </button>
      )}
    </section>
  );
}

/**
 * Usage limit resets left on the account — these restore a reached 5h/weekly
 * limit and expire, so the deadline is called out once it is close. The reset
 * itself is used inside Codex; this card only reports it.
 */
function LimitResets({ limitResets, locale }: { limitResets?: UsageLimitResetsInfo; locale: string }) {
  const { t } = useTranslation();
  if (!limitResets || limitResets.availableCount <= 0) {
    return null;
  }
  const resets = limitResets.resets ?? [];
  return (
    <div className="tw-mt-2 tw-min-w-0" title={t("quota.limitResetsTitle")}>
      <div className="tw-truncate tw-text-[9px] tw-font-semibold tw-tabular-nums tw-text-[var(--vscode-foreground)]">
        {t("quota.limitResetsHeading", { count: limitResets.availableCount })}
      </div>
      {resets.length > 0 && (
        <ol className="tw-mt-0.5 tw-min-w-0 tw-list-none tw-space-y-0.5 tw-p-0">
          {resets.map((reset, index) => (
            <LimitResetItem key={reset.id} reset={reset} position={index + 1} locale={locale} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LimitResetItem({
  reset,
  position,
  locale,
}: {
  reset: UsageLimitReset;
  position: number;
  locale: string;
}) {
  const { t } = useTranslation();
  const expiringSoon = isFiniteNumber(reset.expiresAtUtc)
    && reset.expiresAtUtc - Date.now() <= LIMIT_RESET_EXPIRY_WARNING_MS;
  const title = reset.title ?? t("quota.limitResetFallbackTitle");
  const expiry = isFiniteNumber(reset.expiresAtUtc) ? formatExpiry(reset.expiresAtUtc, locale) : undefined;
  return (
    <li
      className={`tw-truncate tw-text-[9px] tw-tabular-nums ${
        expiringSoon ? "tw-text-chart-yellow" : "tw-text-[var(--vscode-descriptionForeground)]"
      }`}
    >
      {expiry ? t("quota.limitResetItem", { position, title, date: expiry }) : `${position}. ${title}`}
      {expiringSoon && ` (${t("quota.limitResetUseSoon")})`}
    </li>
  );
}

/** Day then time, composed separately so every locale reads date-first. */
function formatExpiry(expiresAtUtc: number, locale: string): string {
  const expiry = new Date(expiresAtUtc);
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(expiry);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(expiry);
  return `${day}, ${time}`;
}

/** Subscription plan of the signed-in account for this provider, e.g. "(Pro Lite)". */
function PlanBadge({ plan }: { plan?: UsagePlanInfo }) {
  const { t } = useTranslation();
  if (!plan) {
    return null;
  }
  return (
    <span
      title={t("quota.planTitle")}
      className="tw-shrink-0 tw-truncate tw-text-[9px] tw-font-medium tw-text-[var(--vscode-descriptionForeground)]"
    >
      ({plan.label})
    </span>
  );
}

function CompactQuota({
  window,
  locale,
  showUnavailableReset = false,
}: {
  window: UsageQuotaWindow;
  locale: string;
  showUnavailableReset?: boolean;
}) {
  const percent = remainingPercent(window.usedPct);
  const { t } = useTranslation();
  const reset = formatReset(window, locale);
  return (
    <div className="tw-min-w-0">
      <div className="tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
        {quotaWindowLabel(window.label)}
      </div>
      <div className="tw-mt-0.5 tw-flex tw-min-w-0 tw-flex-wrap tw-items-baseline tw-gap-x-1.5 tw-text-[10px] tw-tabular-nums">
        {percent && <span className="tw-font-semibold tw-text-[var(--vscode-foreground)]">{percent}</span>}
        {(reset || showUnavailableReset) && (
          <span className="tw-truncate tw-text-[var(--vscode-descriptionForeground)]">
            {reset ? t("quota.reset", { value: reset }) : t("quota.resetUnavailable")}
          </span>
        )}
      </div>
    </div>
  );
}

function remainingPercent(usedPercent?: number): string | undefined {
  return isFiniteNumber(usedPercent) ? formatPercent(Math.max(0, 100 - usedPercent)) : undefined;
}

function formatReset(window: UsageQuotaWindow, locale: string): string | undefined {
  if (!isFiniteNumber(window.resetAtUtc)) {
    return undefined;
  }
  const shortWindow = typeof window.windowSeconds === "number"
    ? window.windowSeconds <= 86_400
    : /5h|session/i.test(window.label);
  return shortWindow
    ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(window.resetAtUtc))
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(window.resetAtUtc));
}

function isFiniteNumber(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
