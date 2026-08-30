import * as vscode from 'vscode';
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, isCodexUsageRateLimitError, readCodexAuthMode } from '../provider/codex';
import { ClaudeConnection, isClaudeUsageRateLimitError } from '../provider/claude';
import type { IngestionCoordinator } from './IngestionCoordinator';
import {
  formatPercent,
  mapCodexUsageToRateLimitInfo,
  nextExpiringLimitReset,
  type CodexUsageResponse,
} from '../shared/codexUsage';
import { mapClaudeUsageToRateLimitInfo, type ClaudeUsageResponse } from '../shared/claudeUsage';
import type {
  AnalyticsResult,
  ClaudeRateLimitInfo,
  RateLimitInfo,
  UsageCacheInfo,
  UsageLimitResetsInfo,
  UsagePlanInfo,
  UsageQuotaWindow,
} from '../shared/protocol';
import type { LimitResetReminder } from './LimitResetReminder';
import { codexLimitResetsFetcher, withLimitResetDetails } from './limitResets';
import { resolveClaudePlan, resolveCodexPlan } from './usagePlan';
import type { DailyAggregate } from '../shared/storeTypes';
import { localeTag, translate, type AppLanguage } from '../shared/i18n';
import type { LanguageController } from './LanguageController';
import { UsageRefreshTimer } from './UsageRefreshTimer';

/**
 * Manages the status bar item showing today's token usage and cost.
 * Refreshes on coordinator data changes; respects the tokenWatch.statusBar.enabled setting.
 */
const CODEX_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function millisecondsUntilNextLocalDay(now: Date): number {
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return nextDay.getTime() - now.getTime();
}

export function localDayRange(now: Date): { fromUtc: number; toUtc: number } {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { fromUtc: startOfDay.getTime(), toUtc: startOfNextDay.getTime() - 1 };
}

export interface StatusBarUsageSummary {
  tokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
}

export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private enabled: boolean;
  private disposed = false;
  private refreshVersion = 0;
  private latestUsage: StatusBarUsageSummary | undefined;
  private latestRateLimit: RateLimitInfo | undefined;
  private rateLimitRefreshPromise: Promise<void> | undefined;
  private latestClaudeRateLimit: ClaudeRateLimitInfo | undefined;
  private claudeRateLimitRefreshPromise: Promise<void> | undefined;
  private lastCodexUsageRefreshAt = 0;
  private lastClaudeUsageRefreshAt = 0;
  private latestCodexUsageMessage: string | undefined;
  private latestClaudeUsageMessage: string | undefined;
  private latestCodexPlan: UsagePlanInfo | undefined;
  private latestClaudePlan: UsagePlanInfo | undefined;
  private dayRolloverTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly codexConnection = new CodexConnection({ authFile: DEFAULT_CODEX_AUTH_FILE });
  private readonly claudeConnection = new ClaudeConnection();
  private readonly codexUsageTimer = new UsageRefreshTimer(() => {
    void this.refreshCodexUsage(true);
  });
  private readonly claudeUsageTimer = new UsageRefreshTimer(() => {
    void this.refreshClaudeUsage(true);
  });

  constructor(
    private readonly coordinator: IngestionCoordinator,
    enabled: boolean,
    private readonly language?: LanguageController,
    private readonly limitResetReminder?: LimitResetReminder,
  ) {
    this.enabled = enabled;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'token-watch.openPanel';

    this.disposables.push(
      coordinator.onChanged(() => this.refresh()),
      ...(language ? [language.onDidChange(() => this.updateItem())] : []),
    );

    if (enabled) {
      void this.refreshCodexUsage(true);
      void this.refreshClaudeUsage(true);
    }
    void this.refresh();
    this.scheduleDayRollover();
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    void this.refreshCodexUsage();
    void this.refreshClaudeUsage();
    const range = localDayRange(new Date());

    let result: AnalyticsResult;
    try {
      result = await this.coordinator.query({
        view: 'series',
        granularity: 'day',
        range,
      });
    } catch (err) {
      if (!this.disposed && version === this.refreshVersion) {
        console.error('[TokenWatch] status bar refresh failed:', err);
      }
      return;
    }

    if (this.disposed || version !== this.refreshVersion) {
      return;
    }

    this.latestUsage = summarizeDailySeries(result.view === 'series' ? result.series : []);
    this.updateItem();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      void this.refreshCodexUsage(true);
      void this.refreshClaudeUsage(true);
      this.item.show();
    } else {
      this.clearUsageTimers();
      this.item.hide();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearUsageTimers();
    if (this.dayRolloverTimer) {
      clearTimeout(this.dayRolloverTimer);
      this.dayRolloverTimer = undefined;
    }
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private scheduleDayRollover(): void {
    const delay = millisecondsUntilNextLocalDay(new Date());
    this.dayRolloverTimer = setTimeout(() => {
      this.dayRolloverTimer = undefined;
      if (this.disposed) {
        return;
      }
      this.scheduleDayRollover();
      void this.refresh();
    }, delay);
  }

  private updateItem(): void {
    if (this.disposed || !this.latestUsage) {
      return;
    }

    this.item.text = buildStatusBarText(this.latestUsage, this.latestRateLimit, this.latestClaudeRateLimit);
    this.item.tooltip = buildStatusBarTooltip(
      this.latestUsage,
      this.latestRateLimit,
      this.latestCodexUsageMessage,
      this.latestClaudeRateLimit,
      this.latestClaudeUsageMessage,
      this.language?.getLanguage(),
      this.latestCodexPlan,
      this.latestClaudePlan,
      this.codexConnection.usageCacheInfo(),
      this.claudeConnection.usageCacheInfo(),
    );

    if (this.enabled) {
      this.item.show();
    }
  }

  private async refreshCodexUsage(force = false): Promise<void> {
    if (this.disposed || !this.enabled) {
      return;
    }
    if (this.rateLimitRefreshPromise) {
      return this.rateLimitRefreshPromise;
    }
    if (!force && Date.now() - this.lastCodexUsageRefreshAt < CODEX_USAGE_REFRESH_INTERVAL_MS) {
      return;
    }

    const refreshPromise = (async () => {
      try {
        const authMode = await readCodexAuthMode(DEFAULT_CODEX_AUTH_FILE);
        if (authMode && authMode !== 'chatgpt') {
          if (this.disposed) {
            return;
          }
          this.lastCodexUsageRefreshAt = Date.now();
          this.latestRateLimit = undefined;
          this.latestCodexPlan = undefined;
          this.latestCodexUsageMessage = "unavailable";
          this.updateItem();
          return;
        }

        const usage = await this.codexConnection.usageInfo<CodexUsageResponse>();
        if (this.disposed) {
          return;
        }
        const rateLimit = mapCodexUsageToRateLimitInfo(usage);
        if (rateLimit) {
          rateLimit.limitResets = await withLimitResetDetails(codexLimitResetsFetcher(this.codexConnection), rateLimit.limitResets);
        }
        this.latestCodexPlan = await resolveCodexPlan(usage.plan_type, this.latestCodexPlan);
        if (this.disposed) {
          return;
        }
        this.lastCodexUsageRefreshAt = Date.now();
        this.latestCodexUsageMessage = undefined;
        if (rateLimit) {
          this.latestRateLimit = rateLimit;
          void this.limitResetReminder?.evaluate(rateLimit.limitResets);
        }
        this.updateItem();
      } catch (err) {
        if (!this.disposed) {
          this.latestCodexPlan = await resolveCodexPlan(undefined, this.latestCodexPlan);
          this.lastCodexUsageRefreshAt = Date.now();
          if (!this.latestRateLimit) {
            this.latestCodexUsageMessage = "unavailable";
          }
          if (!isCodexUsageRateLimitError(err)) {
            console.warn('[TokenWatch] Codex usage refresh failed:', err);
          }
          this.updateItem();
        }
      } finally {
        this.rateLimitRefreshPromise = undefined;
        this.scheduleCodexUsageRefresh();
      }
    })();

    this.rateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async refreshClaudeUsage(force = false): Promise<void> {
    if (this.disposed || !this.enabled) {
      return;
    }
    if (this.claudeRateLimitRefreshPromise) {
      return this.claudeRateLimitRefreshPromise;
    }
    if (!force && Date.now() - this.lastClaudeUsageRefreshAt < CODEX_USAGE_REFRESH_INTERVAL_MS) {
      return;
    }

    const refreshPromise = (async () => {
      try {
        this.latestClaudePlan = await resolveClaudePlan(this.latestClaudePlan);
        const usage = await this.claudeConnection.usageInfo<ClaudeUsageResponse>();
        if (this.disposed) {
          return;
        }
        const rateLimit = mapClaudeUsageToRateLimitInfo(usage);
        this.lastClaudeUsageRefreshAt = Date.now();
        this.latestClaudeUsageMessage = undefined;
        if (rateLimit) {
          this.latestClaudeRateLimit = rateLimit;
        }
        this.updateItem();
      } catch (err) {
        if (!this.disposed) {
          this.lastClaudeUsageRefreshAt = Date.now();
          if (!this.latestClaudeRateLimit) {
            this.latestClaudeUsageMessage = "unavailable";
          }
          if (!isClaudeUsageRateLimitError(err)) {
            console.warn('[TokenWatch] Claude usage refresh failed:', err);
          }
          this.updateItem();
        }
      } finally {
        this.claudeRateLimitRefreshPromise = undefined;
        this.scheduleClaudeUsageRefresh();
      }
    })();

    this.claudeRateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private scheduleCodexUsageRefresh(): void {
    if (this.disposed || !this.enabled) {
      this.codexUsageTimer.clear();
      return;
    }
    const cache = this.codexConnection.usageCacheInfo();
    this.codexUsageTimer.schedule(cache.retryPending ? cache.retryAtUtc : undefined);
  }

  private scheduleClaudeUsageRefresh(): void {
    if (this.disposed || !this.enabled) {
      this.claudeUsageTimer.clear();
      return;
    }
    const cache = this.claudeConnection.usageCacheInfo();
    this.claudeUsageTimer.schedule(cache.retryPending ? cache.retryAtUtc : undefined);
  }

  private clearUsageTimers(): void {
    this.codexUsageTimer.clear();
    this.claudeUsageTimer.clear();
  }
}

export function summarizeDailySeries(series: DailyAggregate[]): StatusBarUsageSummary {
  return series.reduce<StatusBarUsageSummary>((summary, row) => ({
    tokens: summary.tokens + row.totalTokens,
    cost: summary.cost + row.costUsd,
    inputTokens: summary.inputTokens + row.inputTokens,
    outputTokens: summary.outputTokens + row.outputTokens,
    reasoningTokens: summary.reasoningTokens + row.reasoningTokens,
    cacheReadTokens: summary.cacheReadTokens + row.cacheReadTokens,
    cacheCreationTokens: summary.cacheCreationTokens + row.cacheCreationTokens,
    turns: summary.turns + row.turns,
  }), {
    tokens: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  });
}

const CODEX_PRIMARY_WINDOW_IDS = ['codex:primary', 'codex:secondary'];
const CLAUDE_PRIMARY_WINDOW_IDS = ['session', 'weekly'];

/**
 * The status bar label: today's tokens and cost, plus how much subscription
 * quota each provider has left. A provider is left out until its usage loads.
 */
export function buildStatusBarText(
  usage: StatusBarUsageSummary,
  rateLimit?: RateLimitInfo,
  claudeRateLimit?: ClaudeRateLimitInfo,
): string {
  const parts = [`$(token-watch) ${formatTokens(usage.tokens)}`, `$${formatCost(usage.cost)}`];

  const codexLeft = tightestRemainingPercent(rateLimit?.windows, CODEX_PRIMARY_WINDOW_IDS);
  if (codexLeft !== undefined) {
    parts.push(`$(token-watch-codex) ${formatPercent(codexLeft)}`);
  }
  const claudeLeft = tightestRemainingPercent(claudeRateLimit?.windows, CLAUDE_PRIMARY_WINDOW_IDS);
  if (claudeLeft !== undefined) {
    parts.push(`$(token-watch-claude) ${formatPercent(claudeLeft)}`);
  }

  return parts.join(' | ');
}

/** Least headroom across a provider's primary quotas — the one that runs out first. */
function tightestRemainingPercent(windows: UsageQuotaWindow[] | undefined, primaryIds: string[]): number | undefined {
  const remaining = (windows ?? [])
    .filter((window) => primaryIds.includes(window.id))
    .map((window) => window.usedPct)
    .filter((usedPct): usedPct is number => typeof usedPct === 'number' && Number.isFinite(usedPct))
    .map((usedPct) => Math.max(0, 100 - usedPct));

  return remaining.length > 0 ? Math.min(...remaining) : undefined;
}

export function buildStatusBarTooltip(
  usage: StatusBarUsageSummary,
  rateLimit?: RateLimitInfo,
  codexUsageMessage?: string,
  claudeRateLimit?: ClaudeRateLimitInfo,
  claudeUsageMessage?: string,
  language: AppLanguage = "en",
  codexPlan?: UsagePlanInfo,
  claudePlan?: UsagePlanInfo,
  codexUsageCache?: UsageCacheInfo,
  claudeUsageCache?: UsageCacheInfo,
): string {
  const lines = [
    translate(language, "statusBar.currentUsage"),
    '',
    translate(language, "statusBar.usageSummary", { tokens: formatTooltipTokens(usage.tokens), cost: formatCost(usage.cost), turns: usage.turns.toLocaleString(localeTag(language)) }),
    translate(language, "statusBar.tokenBreakdown", { input: formatTooltipTokens(usage.inputTokens), output: formatTooltipTokens(usage.outputTokens), reasoning: formatTooltipTokens(usage.reasoningTokens) }),
    translate(language, "statusBar.cacheBreakdown", { read: formatTooltipTokens(usage.cacheReadTokens), write: formatTooltipTokens(usage.cacheCreationTokens) }),
  ];

  if (codexUsageMessage) {
    lines.push('', providerTitle('CODEX', codexPlan), translate(language, "statusBar.usageUnavailable"));
  } else {
    const codexLines = buildCodexUsageLines(rateLimit, language, codexPlan);
    if (codexLines.length > 0) {
      lines.push('', ...codexLines);
    }
  }

  if (claudeUsageMessage) {
    lines.push('', providerTitle('CLAUDE CODE', claudePlan), translate(language, "statusBar.usageUnavailable"));
  } else {
    const claudeLines = buildClaudeUsageLines(claudeRateLimit, language, claudePlan);
    if (claudeLines.length > 0) {
      lines.push('', ...claudeLines);
    }
  }

  const cacheLine = buildCacheLine([codexUsageCache, claudeUsageCache], language);
  if (cacheLine) {
    lines.push('', cacheLine);
  }

  return lines.join('\n');
}

/**
 * A single trailing line for both providers, instead of repeating the same
 * timestamps under each: how old the oldest shown numbers are, and when the
 * next refresh may run.
 */
function buildCacheLine(caches: Array<UsageCacheInfo | undefined>, language: AppLanguage): string | undefined {
  const parts: string[] = [];
  const cachedAt = formatClockTime(earliest(caches.map((cache) => cache?.cachedAtUtc)), language);
  if (cachedAt) {
    parts.push(translate(language, "statusBar.usageCached", { time: cachedAt }));
  }
  const retryAt = formatClockTime(earliest(caches.map((cache) => cache?.retryAtUtc)), language);
  if (retryAt) {
    parts.push(translate(language, "statusBar.usageRefresh", { time: retryAt }));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function earliest(values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length > 0 ? Math.min(...known) : undefined;
}

function formatClockTime(utcMs: number | undefined, language: AppLanguage): string | undefined {
  if (typeof utcMs !== 'number' || !Number.isFinite(utcMs)) {
    return undefined;
  }
  return new Intl.DateTimeFormat(localeTag(language), { hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(utcMs));
}

/** Usage limit resets left on the account, with the deadline of the first to expire. */
function formatLimitResets(limitResets: UsageLimitResetsInfo | undefined, language: AppLanguage): string | undefined {
  if (!limitResets || limitResets.availableCount <= 0) {
    return undefined;
  }
  const counts = translate(language, "statusBar.limitResets", { count: limitResets.availableCount });
  const expiresAtUtc = nextExpiringLimitReset(limitResets)?.expiresAtUtc;
  const expires = typeof expiresAtUtc === 'number'
    ? translate(language, "statusBar.limitResetExpires", { date: formatCompactDate(expiresAtUtc, language) })
    : undefined;
  return expires ? `${counts} · ${expires}` : counts;
}

function formatCompactDate(utcMs: number, language: AppLanguage): string {
  return new Intl.DateTimeFormat(localeTag(language), { month: 'short', day: 'numeric' }).format(new Date(utcMs));
}

/** Provider heading, carrying the account plan when it is known, e.g. `CODEX (Pro Lite)`. */
function providerTitle(title: string, plan?: UsagePlanInfo): string {
  return plan ? `${title} (${plan.label})` : title;
}

function buildCodexUsageLines(rateLimit: RateLimitInfo | undefined, language: AppLanguage, plan?: UsagePlanInfo): string[] {
  if (!rateLimit) {
    return [];
  }
  const lines = buildCompactUsageLines(providerTitle('CODEX', plan), rateLimit.windows, CODEX_PRIMARY_WINDOW_IDS, language);
  const limitResets = formatLimitResets(rateLimit.limitResets, language);
  return lines.length > 0 && limitResets ? [...lines, limitResets] : lines;
}

function buildClaudeUsageLines(rateLimit: ClaudeRateLimitInfo | undefined, language: AppLanguage, plan?: UsagePlanInfo): string[] {
  if (!rateLimit) {
    return [];
  }
  return buildCompactUsageLines(providerTitle('CLAUDE CODE', plan), rateLimit.windows, CLAUDE_PRIMARY_WINDOW_IDS, language);
}

function buildCompactUsageLines(
  title: string,
  windows: UsageQuotaWindow[],
  primaryIds: string[],
  language: AppLanguage,
): string[] {
  const primarySet = new Set(primaryIds);
  const detailLines = windows
    .filter((window) => primarySet.has(window.id))
    .map((window) => formatPrimaryQuota(window, language))
    .filter((line): line is string => Boolean(line));

  const groups = new Map<string, UsageQuotaWindow[]>();
  for (const window of windows) {
    if (primarySet.has(window.id)) { continue; }
    const descriptor = splitQuotaLabel(window.label);
    const groupWindows = groups.get(descriptor.group) ?? [];
    groupWindows.push({ ...window, label: descriptor.window });
    groups.set(descriptor.group, groupWindows);
  }
  for (const [group, groupWindows] of groups) {
    const parts = groupWindows
      .map((window) => formatGroupedQuota(window, language))
      .filter((line): line is string => Boolean(line));
    if (parts.length > 0) {
      detailLines.push(`${compactGroupName(group)} · ${parts.join(' · ')}`);
    }
  }

  return detailLines.length > 0 ? [title, ...detailLines] : [];
}

function formatPrimaryQuota(window: UsageQuotaWindow, language: AppLanguage): string | undefined {
  const percent = remainingPercent(window.usedPct);
  const reset = formatCompactReset(window, language);
  if (!percent && !reset) { return undefined; }
  const parts = [`${compactWindowLabel(window.label, language)}${percent ? ` ${translate(language, "statusBar.left", { percent })}` : ''}`];
  if (reset) { parts.push(translate(language, "statusBar.resets", { value: reset })); }
  return parts.join(' · ');
}

function formatGroupedQuota(window: UsageQuotaWindow, language: AppLanguage): string | undefined {
  const percent = remainingPercent(window.usedPct);
  const reset = formatCompactReset(window, language);
  if (!percent && !reset) { return undefined; }
  const parts = [`${compactWindowLabel(window.label, language)}${percent ? ` ${percent}` : ''}`];
  if (!percent && reset) { parts.push(translate(language, "statusBar.resets", { value: reset })); }
  return parts.join(' · ');
}

function splitQuotaLabel(label: string): { group: string; window: string } {
  const parts = label.split(' · ').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return { group: label, window: 'Limit' };
  }
  return { group: parts.slice(0, -1).join(' · '), window: parts.at(-1) ?? 'Limit' };
}

function compactGroupName(group: string): string {
  return group
    .replace(/^GPT-[\d.]+-Codex-/i, '')
    .replace(/^Fable(?:\s+\d+)?$/i, 'Fable');
}

function compactWindowLabel(label: string, language: AppLanguage): string {
  if (/weekly|\bweek\b/i.test(label)) { return translate(language, "statusBar.week"); }
  const duration = label.match(/\b\d+(?:\.\d+)?[hmds]\b/i)?.[0];
  return duration ?? label.replace(/\s+limit$/i, '');
}

function formatCompactReset(window: UsageQuotaWindow, language: AppLanguage): string | undefined {
  if (typeof window.resetAtUtc !== 'number' || !Number.isFinite(window.resetAtUtc)) {
    return undefined;
  }
  const shortWindow = typeof window.windowSeconds === 'number'
    ? window.windowSeconds <= 86_400
    : /\b\d+h\b|session/i.test(window.label);
  const date = new Date(window.resetAtUtc);
  return new Intl.DateTimeFormat(localeTag(language), shortWindow
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  ).format(date);
}

function remainingPercent(usedPercent?: number): string | undefined {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    return undefined;
  }

  const remaining = Math.max(0, 100 - usedPercent);
  return formatPercent(remaining);
}

/** Format token count with K/M suffixes for readability. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? m + 'M' : m.toFixed(1) + 'M';
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 === 0 ? k + 'K' : k.toFixed(1) + 'K';
  }
  return String(n);
}

function formatTooltipTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return Math.round(n).toLocaleString();
}

/** Format USD cost to 2 decimal places. */
function formatCost(usd: number): string {
  return usd.toFixed(2);
}
