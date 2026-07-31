import type { RateLimitInfo, UsagePlanInfo, UsageQuotaWindow } from "./protocol";

export interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: CodexRateLimit;
  code_review_rate_limit?: CodexRateLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: CodexRateLimit;
  }>;
}

export interface CodexRateLimit {
  primary_window?: CodexUsageWindow;
  secondary_window?: CodexUsageWindow;
}

export interface CodexUsageWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export function mapCodexUsageToRateLimitInfo(usage: CodexUsageResponse, fetchedAtUtc = Date.now()): RateLimitInfo | undefined {
  const primary = usage.rate_limit?.primary_window;
  const secondary = usage.rate_limit?.secondary_window;
  const windows: UsageQuotaWindow[] = [];
  appendCodexWindows(windows, "codex", undefined, usage.rate_limit, fetchedAtUtc);
  appendCodexWindows(windows, "code-review", "Code Review", usage.code_review_rate_limit, fetchedAtUtc);
  const additionalLimits = Array.isArray(usage.additional_rate_limits) ? usage.additional_rate_limits : [];
  for (const [index, additional] of additionalLimits.entries()) {
    const label = cleanLabel(additional.limit_name) ?? cleanLabel(additional.metered_feature) ?? `Additional limit ${index + 1}`;
    const id = `additional:${slug(additional.metered_feature ?? additional.limit_name ?? String(index))}`;
    appendCodexWindows(windows, id, label, additional.rate_limit, fetchedAtUtc);
  }

  if (windows.length === 0) {
    return undefined;
  }

  return {
    tsUtc: fetchedAtUtc,
    primaryPct: normalizeNumber(primary?.used_percent),
    secondaryPct: normalizeNumber(secondary?.used_percent),
    remainingSeconds: normalizeNumber(primary?.reset_after_seconds),
    weeklyResetAtUtc: normalizeResetAtUtc(secondary?.reset_at),
    windows,
  };
}

/** ChatGPT plan slugs seen on `plan_type` / the `chatgpt_plan_type` id_token claim. */
const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  pro_lite: "Pro Lite",
  business: "Business",
  team: "Team",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** Map a ChatGPT plan slug to the plan shown next to Codex quotas. */
export function codexPlanInfo(planType?: string): UsagePlanInfo | undefined {
  const id = planType?.trim().toLowerCase();
  if (!id) {
    return undefined;
  }
  return { id, label: CODEX_PLAN_LABELS[id] ?? humanizePlan(id) };
}

function humanizePlan(id: string): string {
  return id
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function appendCodexWindows(
  windows: UsageQuotaWindow[],
  id: string,
  groupLabel: string | undefined,
  rateLimit: CodexRateLimit | null | undefined,
  fetchedAtUtc: number,
): void {
  appendCodexWindow(
    windows,
    `${id}:primary`,
    quotaLabel(groupLabel, windowLabel(rateLimit?.primary_window, "5h limit")),
    rateLimit?.primary_window,
    fetchedAtUtc,
  );
  appendCodexWindow(
    windows,
    `${id}:secondary`,
    quotaLabel(groupLabel, windowLabel(rateLimit?.secondary_window, "Weekly")),
    rateLimit?.secondary_window,
    fetchedAtUtc,
  );
}

function appendCodexWindow(
  windows: UsageQuotaWindow[],
  id: string,
  label: string,
  window: CodexUsageWindow | undefined,
  fetchedAtUtc: number,
): void {
  if (!window) {
    return;
  }
  const usedPct = normalizeNumber(window.used_percent);
  const resetAtUtc = normalizeResetAtUtc(window.reset_at)
    ?? (isFiniteNumber(window.reset_after_seconds) ? fetchedAtUtc + window.reset_after_seconds * 1_000 : undefined);
  if (usedPct === undefined && resetAtUtc === undefined) {
    return;
  }
  windows.push({
    id,
    label,
    usedPct,
    resetAtUtc,
    windowSeconds: normalizeNumber(window.limit_window_seconds),
  });
}

function quotaLabel(group: string | undefined, window: string): string {
  return group ? `${group} · ${window}` : window;
}

function windowLabel(window: CodexUsageWindow | undefined, fallback: string): string {
  const seconds = window?.limit_window_seconds;
  if (!isFiniteNumber(seconds) || seconds <= 0) {
    return fallback;
  }
  if (seconds === 604_800) {
    return "Weekly";
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d limit`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h limit`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m limit`;
  }
  return `${seconds}s limit`;
}

function cleanLabel(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function formatDurationShort(totalSeconds?: number): string {
  if (!isFiniteNumber(totalSeconds) || totalSeconds < 0) {
    return "—";
  }

  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${remainingSeconds}s`;
}

export function formatPercent(value?: number): string {
  if (!isFiniteNumber(value)) {
    return "—";
  }

  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

export function formatUtcDateTime(utcMs?: number): string {
  if (!isFiniteNumber(utcMs)) {
    return "—";
  }

  return dateTimeFormatter.format(new Date(utcMs));
}

function normalizeNumber(value?: number): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function normalizeResetAtUtc(value?: number): number | undefined {
  return isFiniteNumber(value) ? value * 1_000 : undefined;
}

function isFiniteNumber(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
