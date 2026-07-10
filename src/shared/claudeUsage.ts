import type { ClaudeRateLimitInfo, UsageQuotaWindow } from "./protocol";

export interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  limits?: ClaudeDynamicLimit[];
  [key: string]: unknown;
}

export interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

export interface ClaudeDynamicLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

export function mapClaudeUsageToRateLimitInfo(
  usage: ClaudeUsageResponse,
  fetchedAtUtc = Date.now(),
): ClaudeRateLimitInfo | undefined {
  const fiveHour = usage.five_hour;
  const weekly = usage.seven_day;
  const windows = collectClaudeWindows(usage);
  if (windows.length === 0) {
    return undefined;
  }

  return {
    tsUtc: fetchedAtUtc,
    fiveHourPct: finiteNumber(fiveHour?.utilization),
    weeklyPct: finiteNumber(weekly?.utilization),
    fiveHourResetAtUtc: timestamp(fiveHour?.resets_at),
    weeklyResetAtUtc: timestamp(weekly?.resets_at),
    windows,
  };
}

function collectClaudeWindows(usage: ClaudeUsageResponse): UsageQuotaWindow[] {
  const windows = new Map<string, UsageQuotaWindow>();

  // Older Claude Code payloads expose quota windows as top-level objects.
  for (const [key, value] of Object.entries(usage)) {
    if (!isUsageWindow(value)) {
      continue;
    }
    const descriptor = topLevelDescriptor(key);
    mergeWindow(windows, {
      id: descriptor.id,
      label: descriptor.label,
      usedPct: finiteNumber(value.utilization),
      resetAtUtc: timestamp(value.resets_at),
    });
  }

  // Current Claude Code payloads provide the authoritative dynamic limit list.
  const dynamicLimits = Array.isArray(usage.limits) ? usage.limits : [];
  for (const [index, limit] of dynamicLimits.entries()) {
    const descriptor = dynamicDescriptor(limit, index);
    mergeWindow(windows, {
      id: descriptor.id,
      label: descriptor.label,
      usedPct: finiteNumber(limit.percent),
      resetAtUtc: timestamp(limit.resets_at ?? undefined),
      ...(typeof limit.is_active === "boolean" ? { isActive: limit.is_active } : {}),
    });
  }

  return [...windows.values()];
}

function topLevelDescriptor(key: string): { id: string; label: string } {
  if (key === "five_hour") {
    return { id: "session", label: "5h limit" };
  }
  if (key === "seven_day") {
    return { id: "weekly", label: "Weekly" };
  }
  if (key === "seven_day_overage_included") {
    return { id: "weekly:model:fable", label: "Fable 5 · Weekly" };
  }
  if (key.startsWith("seven_day_")) {
    const model = humanize(key.slice("seven_day_".length));
    return { id: `weekly:model:${slug(model)}`, label: `${model} · Weekly` };
  }
  return { id: `dynamic:${slug(key)}`, label: humanize(key) };
}

function dynamicDescriptor(limit: ClaudeDynamicLimit, index: number): { id: string; label: string } {
  const kind = limit.kind?.trim() || `limit-${index + 1}`;
  const group = limit.group?.trim();
  const model = limit.scope?.model?.display_name?.trim() || limit.scope?.model?.id?.trim() || undefined;
  const surface = limit.scope?.surface?.trim() || undefined;

  if (kind === "session") {
    return { id: "session", label: "5h limit" };
  }
  if (kind === "weekly_all") {
    return { id: "weekly", label: "Weekly" };
  }
  if (group === "weekly" && model) {
    const surfaceSuffix = surface ? `:surface:${slug(surface)}` : "";
    const scopeLabel = surface ? `${model} (${humanize(surface)})` : model;
    return { id: `weekly:model:${slug(model)}${surfaceSuffix}`, label: `${scopeLabel} · Weekly` };
  }
  if (group === "weekly" && surface) {
    return { id: `weekly:surface:${slug(surface)}`, label: `${humanize(surface)} · Weekly` };
  }

  const scopeLabel = model ?? surface;
  const baseLabel = humanize(kind);
  return {
    id: `dynamic:${slug(kind)}:${slug(scopeLabel ?? String(index))}`,
    label: scopeLabel ? `${scopeLabel} · ${baseLabel}` : baseLabel,
  };
}

function mergeWindow(target: Map<string, UsageQuotaWindow>, incoming: UsageQuotaWindow): void {
  if (incoming.usedPct === undefined && incoming.resetAtUtc === undefined) {
    return;
  }
  const current = target.get(incoming.id);
  if (!current) {
    target.set(incoming.id, incoming);
    return;
  }
  target.set(incoming.id, {
    ...current,
    ...incoming,
    usedPct: incoming.usedPct ?? current.usedPct,
    resetAtUtc: incoming.resetAtUtc ?? current.resetAtUtc,
  });
}

function isUsageWindow(value: unknown): value is ClaudeUsageWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as ClaudeUsageWindow;
  return finiteNumber(candidate.utilization) !== undefined || timestamp(candidate.resets_at) !== undefined;
}

function humanize(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function finiteNumber(value?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
