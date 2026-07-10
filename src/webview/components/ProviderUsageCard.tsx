import { useEffect, useState } from "react";
import { formatPercent } from "../../shared/codexUsage";
import type { UsageCacheInfo, UsageQuotaWindow } from "../../shared/protocol";
import {
  buildProviderQuotaLayout,
  quotaWindowLabel,
  type QuotaProvider,
} from "../quotaGroups";
import { vscodeApi } from "../store";
import { formatUsageTime } from "../usageCacheDisplay";

const TWO_COLUMN_GRID = { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" };

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function ProviderUsageCard({
  provider,
  title,
  windows,
  cacheInfo,
}: {
  provider: QuotaProvider;
  title: string;
  windows: UsageQuotaWindow[];
  cacheInfo?: UsageCacheInfo;
}) {
  const [expanded, setExpanded] = useState(false);
  const [, refreshRetryState] = useState(0);
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
  const cachedLabel = formatUsageTime("Cached at", cacheInfo?.cachedAtUtc);
  const retryAtLabel = formatUsageTime("Retry at", cacheInfo?.retryAtUtc);
  const retryWaiting = Boolean(cacheInfo?.retryAtUtc && cacheInfo.retryAtUtc > Date.now());
  const retryDisabled = Boolean(cacheInfo?.refreshing) || retryWaiting;

  return (
    <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e]">
      <div className="tw-p-3">
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3">
          <div className="tw-truncate tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">
            {title}
          </div>
          <div className={`tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-text-[9px] ${cacheInfo?.unavailable && windows.length === 0 ? "tw-text-[var(--vscode-descriptionForeground)]" : "tw-text-[#89d185]"}`}>
            <span className={`tw-h-1.5 tw-w-1.5 tw-rounded-full ${cacheInfo?.unavailable && windows.length === 0 ? "tw-bg-[var(--vscode-descriptionForeground)]" : "tw-bg-[#89d185]"}`} />
            {cacheInfo?.unavailable && windows.length === 0 ? "Unavailable" : "Active"}
          </div>
        </div>

        {layout.primaryWindows.length > 0 && (
          <div className="tw-mt-2 tw-grid tw-gap-x-3 tw-gap-y-1.5" style={TWO_COLUMN_GRID}>
            {layout.primaryWindows.map((window) => (
              <CompactQuota key={window.id} window={window} />
            ))}
          </div>
        )}

        {layout.primaryWindows.length === 0 && cacheInfo?.unavailable && (
          <div className="tw-mt-2 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
            Usage data is not available
          </div>
        )}

        {cacheInfo && (
          <div className="tw-mt-2 tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-[#2a2a3a] tw-pt-2">
            <span className="tw-min-w-0 tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
              {cachedLabel ?? (cacheInfo.refreshing ? "Fetching usage…" : "No cached data")}
            </span>
            <button
              type="button"
              disabled={retryDisabled}
              onClick={() => vscodeApi.postMessage({ type: "refreshUsage", provider })}
              className="tw-shrink-0 tw-rounded tw-border tw-border-[#34344a] tw-px-2 tw-py-0.5 tw-text-[8px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] enabled:tw-cursor-pointer enabled:hover:tw-bg-[#25253a] disabled:tw-cursor-not-allowed disabled:tw-opacity-50"
            >
              {cacheInfo.refreshing
                ? "Refreshing…"
                : retryWaiting
                  ? retryAtLabel
                  : "Retry"}
            </button>
          </div>
        )}
      </div>

      {expanded && layout.additionalGroups.map((group) => (
        <div key={group.id} className="tw-border-t tw-border-[#2a2a3a] tw-p-3">
          <div className="tw-truncate tw-text-[9px] tw-font-medium tw-uppercase tw-text-[var(--vscode-foreground)]" title={group.name}>
            {group.name}
          </div>
          <div className="tw-mt-2 tw-grid tw-gap-x-3 tw-gap-y-1.5" style={TWO_COLUMN_GRID}>
            {group.windows.map((window) => (
              <CompactQuota key={window.id} window={window} showUnavailableReset />
            ))}
          </div>
        </div>
      ))}

      {hasAdditional && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-[#2a2a3a] tw-bg-[#141426] tw-px-3 tw-py-2 tw-text-left hover:tw-bg-[#18182a]"
        >
          <span className="tw-min-w-0 tw-truncate tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
            {expanded ? "" : layout.collapsedSummary}
          </span>
          <span className="tw-flex tw-shrink-0 tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)]">
            {expanded ? "Show less" : "Show more"}
            <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
          </span>
        </button>
      )}
    </section>
  );
}

function CompactQuota({
  window,
  showUnavailableReset = false,
}: {
  window: UsageQuotaWindow;
  showUnavailableReset?: boolean;
}) {
  const percent = remainingPercent(window.usedPct);
  const reset = formatReset(window);
  return (
    <div className="tw-min-w-0">
      <div className="tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
        {quotaWindowLabel(window.label)}
      </div>
      <div className="tw-mt-0.5 tw-flex tw-min-w-0 tw-flex-wrap tw-items-baseline tw-gap-x-1.5 tw-text-[10px] tw-tabular-nums">
        {percent && <span className="tw-font-semibold tw-text-[var(--vscode-foreground)]">{percent}</span>}
        {(reset || showUnavailableReset) && (
          <span className="tw-truncate tw-text-[var(--vscode-descriptionForeground)]">
            {reset ? `Reset ${reset}` : "Reset unavailable"}
          </span>
        )}
      </div>
    </div>
  );
}

function remainingPercent(usedPercent?: number): string | undefined {
  return isFiniteNumber(usedPercent) ? formatPercent(Math.max(0, 100 - usedPercent)) : undefined;
}

function formatReset(window: UsageQuotaWindow): string | undefined {
  if (!isFiniteNumber(window.resetAtUtc)) {
    return undefined;
  }
  const shortWindow = typeof window.windowSeconds === "number"
    ? window.windowSeconds <= 86_400
    : /5h|session/i.test(window.label);
  return shortWindow
    ? timeFormatter.format(new Date(window.resetAtUtc))
    : dateFormatter.format(new Date(window.resetAtUtc));
}

function isFiniteNumber(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
