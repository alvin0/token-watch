import type { RateLimitInfo } from "./protocol";

export interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexUsageWindow;
    secondary_window?: CodexUsageWindow;
  };
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
  if (!primary && !secondary) {
    return undefined;
  }

  return {
    tsUtc: fetchedAtUtc,
    primaryPct: normalizeNumber(primary?.used_percent),
    secondaryPct: normalizeNumber(secondary?.used_percent),
    remainingSeconds: normalizeNumber(primary?.reset_after_seconds),
    weeklyResetAtUtc: normalizeResetAtUtc(secondary?.reset_at),
  };
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
