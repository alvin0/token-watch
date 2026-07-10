import type { UsageQuotaWindow } from "../shared/protocol";

export type QuotaProvider = "codex" | "claude";

export interface AdditionalQuotaGroup {
  id: string;
  name: string;
  windows: UsageQuotaWindow[];
}

export interface ProviderQuotaLayout {
  primaryWindows: UsageQuotaWindow[];
  additionalGroups: AdditionalQuotaGroup[];
  additionalLimitCount: number;
  collapsedSummary?: string;
}

export function buildProviderQuotaLayout(
  provider: QuotaProvider,
  windows: UsageQuotaWindow[],
): ProviderQuotaLayout {
  const visible = windows.filter(hasUsageQuotaData);
  const primaryWindows = visible.filter((window) => isPrimaryWindow(provider, window));
  const additional = visible.filter((window) => !isPrimaryWindow(provider, window));
  const groups = new Map<string, AdditionalQuotaGroup>();

  for (const window of additional) {
    const name = quotaGroupName(window.label);
    const id = slug(name) || window.id;
    const group = groups.get(id) ?? { id, name, windows: [] };
    group.windows.push(window);
    groups.set(id, group);
  }

  const additionalGroups = [...groups.values()];
  const additionalLimitCount = additionalGroups.reduce((sum, group) => sum + group.windows.length, 0);

  return {
    primaryWindows,
    additionalGroups,
    additionalLimitCount,
    collapsedSummary: collapsedSummary(additionalGroups, additionalLimitCount),
  };
}

export function hasUsageQuotaData(window: UsageQuotaWindow): boolean {
  return isFiniteNumber(window.usedPct) || isFiniteNumber(window.resetAtUtc);
}

export function quotaWindowLabel(label: string): string {
  const parts = label.split(" · ");
  const windowLabel = parts.length > 1 ? parts.slice(1).join(" · ") : label;
  return windowLabel === "5h limit" ? "5h" : windowLabel;
}

function isPrimaryWindow(provider: QuotaProvider, window: UsageQuotaWindow): boolean {
  if (provider === "codex") {
    return window.id === "codex:primary" || window.id === "codex:secondary";
  }
  return window.id === "session" || window.id === "weekly";
}

function quotaGroupName(label: string): string {
  const [name] = label.split(" · ");
  return name.trim() || label;
}

function collapsedSummary(groups: AdditionalQuotaGroup[], count: number): string | undefined {
  if (count === 0) {
    return undefined;
  }
  if (groups.length === 1) {
    const noun = count === 1 ? "additional limit" : "limits";
    return `${groups[0].name} · ${count} ${noun}`;
  }
  return `${count} additional limits`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isFiniteNumber(value?: number): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
