import * as vscode from "vscode";
import type { IngestionCoordinator } from "./IngestionCoordinator";

/**
 * Manages the status bar item showing today's token usage and cost.
 * Refreshes on coordinator data changes; respects the `tokenWatch.statusBar.enabled` setting.
 */
export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private enabled: boolean;

  constructor(
    private readonly coordinator: IngestionCoordinator,
    enabled: boolean,
  ) {
    this.enabled = enabled;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "token-watch.openPanel";

    this.disposables.push(
      coordinator.onChanged(() => this.refresh()),
    );

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000 - 1);

    const result = await this.coordinator.query({
      view: "dashboard",
      granularity: "day",
      range: { fromUtc: startOfDay.getTime(), toUtc: endOfDay.getTime() },
    });

    let tokens = 0;
    let cost = 0;

    if (result.view === "dashboard") {
      for (const row of result.series) {
        tokens += row.totalTokens;
        cost += row.costUsd;
      }
    }

    const tokensStr = formatTokens(tokens);
    const costStr = formatCost(cost);
    this.item.text = `$(zap) ${tokensStr} | $${costStr}`;
    this.item.tooltip = "Token Watch – Today's usage";

    if (this.enabled) {
      this.item.show();
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

/** Format token count with K/M suffixes for readability. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(n);
}

/** Format USD cost to 2 decimal places. */
function formatCost(usd: number): string {
  return usd.toFixed(2);
}
