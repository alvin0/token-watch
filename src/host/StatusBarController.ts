import * as vscode from 'vscode';
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, readCodexAuthMode } from '../provider/codex';
import type { IngestionCoordinator } from './IngestionCoordinator';
import {
  formatDurationShort,
  formatPercent,
  formatUtcDateTime,
  mapCodexUsageToRateLimitInfo,
  type CodexUsageResponse,
} from '../shared/codexUsage';
import type { AnalyticsResult, RateLimitInfo } from '../shared/protocol';

/**
 * Manages the status bar item showing today's token usage and cost.
 * Refreshes on coordinator data changes; respects the tokenWatch.statusBar.enabled setting.
 */
const CODEX_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CODEX_USAGE_NOT_AVAILABLE_MESSAGE = 'Codex usage not avilable';

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
  private lastCodexUsageRefreshAt = 0;
  private latestCodexUsageMessage: string | undefined;
  private readonly codexConnection = new CodexConnection({ authFile: DEFAULT_CODEX_AUTH_FILE });

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
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    void this.refreshCodexUsage();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000 - 1);

    let result: AnalyticsResult;
    try {
      result = await this.coordinator.query({
        view: 'dashboard',
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

    let tokens = 0;
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let turns = 0;

    if (result.view === 'dashboard') {
      for (const row of result.series) {
        tokens += row.totalTokens;
        cost += row.costUsd;
        inputTokens += row.inputTokens;
        outputTokens += row.outputTokens;
        reasoningTokens += row.reasoningTokens;
        cacheReadTokens += row.cacheReadTokens;
        cacheCreationTokens += row.cacheCreationTokens;
        turns += row.turns;
      }
    }

    this.latestUsage = {
      tokens,
      cost,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheCreationTokens,
      turns,
    };
    this.updateItem();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      void this.refreshCodexUsage();
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
    this.item.tooltip = buildStatusBarTooltip(this.latestUsage, this.latestRateLimit, this.latestCodexUsageMessage);

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
          this.latestRateLimit = undefined;
          this.latestCodexUsageMessage = CODEX_USAGE_NOT_AVAILABLE_MESSAGE;
          console.warn('[TokenWatch] Codex usage refresh failed:', err);
          this.updateItem();
        }
      } finally {
        this.rateLimitRefreshPromise = undefined;
      }
    })();

    this.rateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }
}

export function buildStatusBarTooltip(
  usage: StatusBarUsageSummary,
  rateLimit?: RateLimitInfo,
  codexUsageMessage?: string,
): string {
  const lines = [
    'Token Watch - Current usage',
    '',
    'Input: ' + formatTokenDetail(usage.inputTokens),
    'Output: ' + formatTokenDetail(usage.outputTokens),
    'Reasoning: ' + formatTokenDetail(usage.reasoningTokens),
    'Cache read: ' + formatTokenDetail(usage.cacheReadTokens),
    'Cache write: ' + formatTokenDetail(usage.cacheCreationTokens),
    '',
    'Total: ' + formatTokenDetail(usage.tokens),
    'Turns: ' + usage.turns.toLocaleString(),
    'Cost: $' + formatCost(usage.cost),
  ];

  if (codexUsageMessage) {
    lines.push('', codexUsageMessage);
  } else {
    const codexLines = buildCodexUsageLines(rateLimit);
    if (codexLines.length > 0) {
      lines.push('', ...codexLines);
    }
  }

  return lines.join('\n');
}

function buildCodexUsageLines(rateLimit?: RateLimitInfo): string[] {
  if (!rateLimit) {
    return [];
  }

  const lines = ['Codex usage'];

  const primaryParts: string[] = [];
  if (typeof rateLimit.primaryPct === 'number') {
    primaryParts.push('5h limit: ' + remainingPercent(rateLimit.primaryPct) + ' remaining');
  } else if (typeof rateLimit.remainingSeconds === 'number') {
    primaryParts.push('5h limit: n/a remaining');
  }
  if (typeof rateLimit.remainingSeconds === 'number') {
    primaryParts.push('resets in ' + formatDurationShort(rateLimit.remainingSeconds));
  }
  if (primaryParts.length > 0) {
    lines.push(primaryParts.join(' | '));
  }

  const weeklyParts: string[] = [];
  if (typeof rateLimit.secondaryPct === 'number') {
    weeklyParts.push('Weekly: ' + remainingPercent(rateLimit.secondaryPct) + ' remaining');
  } else if (typeof rateLimit.weeklyResetAtUtc === 'number') {
    weeklyParts.push('Weekly: n/a remaining');
  }
  if (typeof rateLimit.weeklyResetAtUtc === 'number') {
    weeklyParts.push('resets ' + formatUtcDateTime(rateLimit.weeklyResetAtUtc));
  }
  if (weeklyParts.length > 0) {
    lines.push(weeklyParts.join(' | '));
  }

  return lines;
}

function remainingPercent(usedPercent?: number): string {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    return 'n/a';
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

/** Format an exact token count with a compact suffix for tooltip rows. */
function formatTokenDetail(n: number): string {
  const exact = Math.round(n).toLocaleString();
  const compact = formatTokens(n);
  return exact === compact ? exact : exact + ' (' + compact + ')';
}

/** Format USD cost to 2 decimal places. */
function formatCost(usd: number): string {
  return usd.toFixed(2);
}