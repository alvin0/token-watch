import * as vscode from 'vscode';
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, isCodexUsageRateLimitError, readCodexAuthMode } from '../provider/codex';
import { ClaudeConnection, isClaudeUsageRateLimitError } from '../provider/claude';
import type { IngestionCoordinator } from './IngestionCoordinator';
import {
  formatPercent,
  mapCodexUsageToRateLimitInfo,
  type CodexUsageResponse,
} from '../shared/codexUsage';
import { mapClaudeUsageToRateLimitInfo, type ClaudeUsageResponse } from '../shared/claudeUsage';
import type { AnalyticsResult, ClaudeRateLimitInfo, RateLimitInfo, UsageQuotaWindow } from '../shared/protocol';
import type { DailyAggregate } from '../shared/storeTypes';

/**
 * Manages the status bar item showing today's token usage and cost.
 * Refreshes on coordinator data changes; respects the tokenWatch.statusBar.enabled setting.
 */
const CODEX_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CODEX_USAGE_NOT_AVAILABLE_MESSAGE = 'Codex usage not available';
const CLAUDE_USAGE_NOT_AVAILABLE_MESSAGE = 'Claude Code usage not available';

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
  private readonly codexConnection = new CodexConnection({ authFile: DEFAULT_CODEX_AUTH_FILE });
  private readonly claudeConnection = new ClaudeConnection();

  constructor(
    private readonly coordinator: IngestionCoordinator,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'token-watch.openPanel';

    this.disposables.push(
      coordinator.onChanged(() => this.refresh()),
    );

    void this.refreshCodexUsage(true);
    void this.refreshClaudeUsage(true);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    void this.refreshCodexUsage();
    void this.refreshClaudeUsage();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000 - 1);

    let result: AnalyticsResult;
    try {
      result = await this.coordinator.query({
        view: 'series',
        granularity: 'day',
        range: { fromUtc: startOfDay.getTime(), toUtc: endOfDay.getTime() },
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
      void this.refreshCodexUsage();
      void this.refreshClaudeUsage();
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private updateItem(): void {
    if (this.disposed || !this.latestUsage) {
      return;
    }

    const tokensStr = formatTokens(this.latestUsage.tokens);
    const costStr = formatCost(this.latestUsage.cost);
    this.item.text = '$' + '(zap) ' + tokensStr + ' | $' + costStr;
    this.item.tooltip = buildStatusBarTooltip(
      this.latestUsage,
      this.latestRateLimit,
      this.latestCodexUsageMessage,
      this.latestClaudeRateLimit,
      this.latestClaudeUsageMessage,
    );

    if (this.enabled) {
      this.item.show();
    }
  }

  private async refreshCodexUsage(force = false): Promise<void> {
    if (this.disposed) {
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
          this.latestCodexUsageMessage = CODEX_USAGE_NOT_AVAILABLE_MESSAGE;
          this.updateItem();
          return;
        }

        const usage = await this.codexConnection.usageInfo<CodexUsageResponse>();
        if (this.disposed) {
          return;
        }
        const rateLimit = mapCodexUsageToRateLimitInfo(usage);
        this.lastCodexUsageRefreshAt = Date.now();
        this.latestCodexUsageMessage = undefined;
        if (rateLimit) {
          this.latestRateLimit = rateLimit;
        }
        this.updateItem();
      } catch (err) {
        if (!this.disposed) {
          this.lastCodexUsageRefreshAt = Date.now();
          if (!this.latestRateLimit) {
            this.latestCodexUsageMessage = CODEX_USAGE_NOT_AVAILABLE_MESSAGE;
          }
          if (!isCodexUsageRateLimitError(err)) {
            console.warn('[TokenWatch] Codex usage refresh failed:', err);
          }
          this.updateItem();
        }
      } finally {
        this.rateLimitRefreshPromise = undefined;
      }
    })();

    this.rateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async refreshClaudeUsage(force = false): Promise<void> {
    if (this.disposed) {
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
            this.latestClaudeUsageMessage = CLAUDE_USAGE_NOT_AVAILABLE_MESSAGE;
          }
          if (!isClaudeUsageRateLimitError(err)) {
            console.warn('[TokenWatch] Claude usage refresh failed:', err);
          }
          this.updateItem();
        }
      } finally {
        this.claudeRateLimitRefreshPromise = undefined;
      }
    })();

    this.claudeRateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
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

export function buildStatusBarTooltip(
  usage: StatusBarUsageSummary,
  rateLimit?: RateLimitInfo,
  codexUsageMessage?: string,
  claudeRateLimit?: ClaudeRateLimitInfo,
  claudeUsageMessage?: string,
): string {
  const lines = [
    'Token Watch · Current usage',
    '',
    `${formatTooltipTokens(usage.tokens)} tokens · $${formatCost(usage.cost)} · ${usage.turns.toLocaleString()} turns`,
    `Input ${formatTooltipTokens(usage.inputTokens)} · Output ${formatTooltipTokens(usage.outputTokens)} · Reasoning ${formatTooltipTokens(usage.reasoningTokens)}`,
    `Cache ${formatTooltipTokens(usage.cacheReadTokens)} read · ${formatTooltipTokens(usage.cacheCreationTokens)} write`,
  ];

  if (codexUsageMessage) {
    lines.push('', 'CODEX', 'Usage not available');
  } else {
    const codexLines = buildCodexUsageLines(rateLimit);
    if (codexLines.length > 0) {
      lines.push('', ...codexLines);
    }
  }

  if (claudeUsageMessage) {
    lines.push('', 'CLAUDE CODE', 'Usage not available');
  } else {
    const claudeLines = buildClaudeUsageLines(claudeRateLimit);
    if (claudeLines.length > 0) {
      lines.push('', ...claudeLines);
    }
  }

  return lines.join('\n');
}

function buildCodexUsageLines(rateLimit?: RateLimitInfo): string[] {
  if (!rateLimit) {
    return [];
  }
  return buildCompactUsageLines('CODEX', rateLimit.windows, ['codex:primary', 'codex:secondary']);
}

function buildClaudeUsageLines(rateLimit?: ClaudeRateLimitInfo): string[] {
  if (!rateLimit) {
    return [];
  }
  return buildCompactUsageLines('CLAUDE CODE', rateLimit.windows, ['session', 'weekly']);
}

function buildCompactUsageLines(
  title: string,
  windows: UsageQuotaWindow[],
  primaryIds: string[],
): string[] {
  const primarySet = new Set(primaryIds);
  const detailLines = windows
    .filter((window) => primarySet.has(window.id))
    .map(formatPrimaryQuota)
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
      .map(formatGroupedQuota)
      .filter((line): line is string => Boolean(line));
    if (parts.length > 0) {
      detailLines.push(`${compactGroupName(group)} · ${parts.join(' · ')}`);
    }
  }

  return detailLines.length > 0 ? [title, ...detailLines] : [];
}

function formatPrimaryQuota(window: UsageQuotaWindow): string | undefined {
  const percent = remainingPercent(window.usedPct);
  const reset = formatCompactReset(window);
  if (!percent && !reset) { return undefined; }
  const parts = [`${compactWindowLabel(window.label)}${percent ? ` ${percent} left` : ''}`];
  if (reset) { parts.push(`resets ${reset}`); }
  return parts.join(' · ');
}

function formatGroupedQuota(window: UsageQuotaWindow): string | undefined {
  const percent = remainingPercent(window.usedPct);
  const reset = formatCompactReset(window);
  if (!percent && !reset) { return undefined; }
  const parts = [`${compactWindowLabel(window.label)}${percent ? ` ${percent}` : ''}`];
  if (!percent && reset) { parts.push(`resets ${reset}`); }
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

function compactWindowLabel(label: string): string {
  if (/weekly|\bweek\b/i.test(label)) { return 'Week'; }
  const duration = label.match(/\b\d+(?:\.\d+)?[hmds]\b/i)?.[0];
  return duration ?? label.replace(/\s+limit$/i, '');
}

function formatCompactReset(window: UsageQuotaWindow): string | undefined {
  if (typeof window.resetAtUtc !== 'number' || !Number.isFinite(window.resetAtUtc)) {
    return undefined;
  }
  const shortWindow = typeof window.windowSeconds === 'number'
    ? window.windowSeconds <= 86_400
    : /\b\d+h\b|session/i.test(window.label);
  const date = new Date(window.resetAtUtc);
  return shortWindow ? resetTimeFormatter.format(date) : resetDateTimeFormatter.format(date);
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

const resetTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const resetDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
