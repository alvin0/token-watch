import * as vscode from "vscode";
import { getNonce } from "./utils";
import { isCoordinatorDisposedError, type IngestionCoordinator } from "./host/IngestionCoordinator";
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, isCodexUsageRateLimitError } from "./provider/codex";
import { ClaudeConnection, isClaudeUsageRateLimitError } from "./provider/claude";
import { mapCodexUsageToRateLimitInfo, type CodexUsageResponse } from "./shared/codexUsage";
import { mapClaudeUsageToRateLimitInfo, type ClaudeUsageResponse } from "./shared/claudeUsage";
import type { CostAlertController } from "./host/CostAlertController";
import type { LanguageController } from "./host/LanguageController";
import { effectivePricingOverrides, getConfig } from "./host/config";
import type { ModelRate, PricingTable } from "./shared/types";
import type {
  WebviewRequest,
  HostMessage,
  DisplayCurrencyConfig,
  FreshnessInfo,
  ClaudeRateLimitInfo,
  RateLimitInfo,
  UsageCacheInfo,
  WarningInfo,
} from "./shared/protocol";
import { UsageRefreshTimer } from "./host/UsageRefreshTimer";

const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "token-watch.sidebarView";

  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private currency: DisplayCurrencyConfig;
  private latestFreshness: FreshnessInfo = {};
  private latestWarnings: WarningInfo = { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0 };
  private latestRateLimit: RateLimitInfo | undefined;
  private latestClaudeRateLimit: ClaudeRateLimitInfo | undefined;
  private latestCodexUsageCache: UsageCacheInfo | undefined;
  private latestClaudeUsageCache: UsageCacheInfo | undefined;
  private readonly codexConnection = new CodexConnection({ authFile: DEFAULT_CODEX_AUTH_FILE });
  private readonly claudeConnection = new ClaudeConnection();
  private rateLimitRefreshPromise: Promise<void> | undefined;
  private claudeRateLimitRefreshPromise: Promise<void> | undefined;
  private lastCodexUsageRefreshAt = 0;
  private lastClaudeUsageRefreshAt = 0;
  private disposed = false;
  private readonly codexUsageTimer = new UsageRefreshTimer(() => {
    void this.refreshCodexUsage(true);
  });
  private readonly claudeUsageTimer = new UsageRefreshTimer(() => {
    void this.refreshClaudeUsage(true);
  });

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly coordinator: IngestionCoordinator,
    private readonly costAlerts: CostAlertController,
    private readonly language: LanguageController,
    currency: DisplayCurrencyConfig,
  ) {
    this.currency = currency;

    // Subscribe to coordinator data changes → push dataChanged to WebView
    this.disposables.push(
      coordinator.onChanged(() => {
        this.postMessage({ type: "dataChanged" });
        void this.refreshCodexUsage();
        void this.refreshClaudeUsage();
      }),
      coordinator.onScanComplete((freshness) => {
        this.latestFreshness = freshness;
        this.pushStatus();
      }),
      coordinator.onProgress((progress) => {
        this.postMessage({ type: "ingestProgress", processed: progress.processed, total: progress.total, partial: progress.partial });
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    if (this.disposed) {
      return;
    }
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);
    if (webviewView.visible) {
      void this.refreshCodexUsage(true);
      void this.refreshClaudeUsage(true);
    }

    // WebView → host message relay
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewRequest) => {
        this.handleWebviewMessage(message);
      },
      undefined,
      this.disposables,
    );

    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (this.view !== webviewView) {
          return;
        }
        if (webviewView.visible) {
          void this.refreshCodexUsage(true);
          void this.refreshClaudeUsage(true);
        } else {
          this.clearUsageTimers();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.clearUsageTimers();
        }
      }),
    );
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.view = undefined;
    this.clearUsageTimers();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /** Push updated currency config to the WebView (called on config change). */
  pushCurrency(currency: DisplayCurrencyConfig): void {
    this.currency = currency;
    this.pushStatus();
  }

  private pushStatus(): void {
    this.postMessage({
      type: "status",
      freshness: this.latestFreshness,
      warnings: this.latestWarnings,
      rateLimit: this.latestRateLimit,
      claudeRateLimit: this.latestClaudeRateLimit,
      codexUsageCache: this.latestCodexUsageCache,
      claudeUsageCache: this.latestClaudeUsageCache,
      currency: this.currency,
    });
  }

  private async refreshClaudeUsage(force = false, bypassCache = false): Promise<void> {
    if (!this.isUsageActive()) {
      return;
    }
    if (this.claudeRateLimitRefreshPromise) {
      return this.claudeRateLimitRefreshPromise;
    }
    if (!force && Date.now() - this.lastClaudeUsageRefreshAt < USAGE_REFRESH_INTERVAL_MS) {
      return;
    }

    this.latestClaudeUsageCache = {
      ...this.claudeConnection.usageCacheInfo(),
      refreshing: true,
      unavailable: !this.latestClaudeRateLimit,
    };
    this.pushStatus();

    const refreshPromise = this.claudeConnection.usageInfo<ClaudeUsageResponse>({ force: bypassCache })
      .then((usage) => {
        const rateLimit = mapClaudeUsageToRateLimitInfo(usage);
        if (rateLimit) {
          this.latestClaudeRateLimit = rateLimit;
        }
        this.latestClaudeUsageCache = {
          ...this.claudeConnection.usageCacheInfo(),
          unavailable: !this.latestClaudeRateLimit,
        };
      })
      .catch((error) => {
        if (!isClaudeUsageRateLimitError(error)) {
          console.warn("[TokenWatch] Claude usage refresh failed:", error);
        }
        this.latestClaudeUsageCache = {
          ...this.claudeConnection.usageCacheInfo(),
          unavailable: !this.latestClaudeRateLimit,
        };
      })
      .finally(() => {
        this.lastClaudeUsageRefreshAt = Date.now();
        this.claudeRateLimitRefreshPromise = undefined;
        this.latestClaudeUsageCache = {
          ...this.claudeConnection.usageCacheInfo(),
          refreshing: false,
          unavailable: !this.latestClaudeRateLimit,
        };
        this.pushStatus();
        this.scheduleClaudeUsageRefresh();
      });

    this.claudeRateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async refreshCodexUsage(force = false, bypassCache = false): Promise<void> {
    if (!this.isUsageActive()) {
      return;
    }
    if (this.rateLimitRefreshPromise) {
      return this.rateLimitRefreshPromise;
    }
    if (!force && Date.now() - this.lastCodexUsageRefreshAt < USAGE_REFRESH_INTERVAL_MS) {
      return;
    }

    this.latestCodexUsageCache = {
      ...this.codexConnection.usageCacheInfo(),
      refreshing: true,
      unavailable: !this.latestRateLimit,
    };
    this.pushStatus();

    const refreshPromise = this.codexConnection.usageInfo<CodexUsageResponse>({ force: bypassCache })
      .then((usage) => {
        const rateLimit = mapCodexUsageToRateLimitInfo(usage);
        if (rateLimit) {
          this.latestRateLimit = rateLimit;
        }
        this.latestCodexUsageCache = {
          ...this.codexConnection.usageCacheInfo(),
          unavailable: !this.latestRateLimit,
        };
      })
      .catch((error) => {
        if (!isCodexUsageRateLimitError(error)) {
          console.warn("[TokenWatch] Codex usage refresh failed:", error);
        }
        this.latestCodexUsageCache = {
          ...this.codexConnection.usageCacheInfo(),
          unavailable: !this.latestRateLimit,
        };
      })
      .finally(() => {
        this.lastCodexUsageRefreshAt = Date.now();
        this.rateLimitRefreshPromise = undefined;
        this.latestCodexUsageCache = {
          ...this.codexConnection.usageCacheInfo(),
          refreshing: false,
          unavailable: !this.latestRateLimit,
        };
        this.pushStatus();
        this.scheduleCodexUsageRefresh();
      });

    this.rateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private isUsageActive(): boolean {
    return !this.disposed && Boolean(this.view?.visible);
  }

  private scheduleCodexUsageRefresh(): void {
    if (!this.isUsageActive()) {
      this.codexUsageTimer.clear();
      return;
    }
    const cache = this.codexConnection.usageCacheInfo();
    this.codexUsageTimer.schedule(cache.retryPending ? cache.retryAtUtc : undefined);
  }

  private scheduleClaudeUsageRefresh(): void {
    if (!this.isUsageActive()) {
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

  private handleWebviewMessage(message: WebviewRequest): void {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case "ready":
        // WebView loaded — push initial status
        this.pushStatus();
        this.pushCostAlertSettings();
        this.pushPricingSettings();
        this.pushLanguage();
        void this.refreshCodexUsage();
        void this.refreshClaudeUsage();
        break;
      case "query":
        this.coordinator.query(message.query).then(
          (result) => {
            this.postMessage({ type: "queryResult", id: message.id, result });
          },
          (err) => {
            if (this.disposed || isCoordinatorDisposedError(err)) {
              return;
            }
            // Query failed — log but don't crash.
            console.error("[TokenWatch] query error:", err);
            const errorMessage = err instanceof Error ? err.message : "Unknown query error";
            this.postMessage({ type: "queryError", id: message.id, message: errorMessage });
          },
        );
        break;
      case "rescan":
        this.coordinator.rescan();
        break;
      case "updatePricing":
        void this.coordinator.updatePricing(message.table).catch((error) => {
          console.error("[TokenWatch] pricing update failed:", error);
        });
        break;
      case "refreshUsage":
        if (message.provider === "codex") {
          void this.refreshCodexUsage(true, true);
        } else {
          void this.refreshClaudeUsage(true, true);
        }
        break;
      case "openSetting":
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `tokenWatch.${message.key}`,
        );
        break;
      case "saveCostAlertSettings":
        if (typeof message.requestId !== "string" || !message.requestId) {
          console.warn("[TokenWatch] ignored cost alert settings with an invalid request ID");
          break;
        }
        this.costAlerts.saveRules(message.rules).then(
          (rules) => {
            this.postMessage({ type: "costAlertSettingsSaved", requestId: message.requestId, rules });
          },
          (error) => {
            const errorMessage = error instanceof Error ? error.message : "Unable to save cost alerts.";
            this.postMessage({ type: "costAlertSettingsError", requestId: message.requestId, message: errorMessage });
          },
        );
        break;
      case "savePricingSettings":
        if (typeof message.requestId !== "string" || !message.requestId) {
          console.warn("[TokenWatch] ignored pricing settings with an invalid request ID");
          break;
        }
        this.savePricingSettings(message.table).then(
          (table) => this.postMessage({ type: "pricingSettingsSaved", requestId: message.requestId, table }),
          (error) => {
            const errorMessage = error instanceof Error ? error.message : "Unable to save custom pricing.";
            this.postMessage({ type: "pricingSettingsError", requestId: message.requestId, message: errorMessage });
          },
        );
        break;
      case "setLanguage":
        this.language.setLanguage(message.language).then(
          (language) => this.postMessage({ type: "language", language }),
          (error) => console.warn("[TokenWatch] language change failed:", error),
        );
        break;
    }
  }

  private pushCostAlertSettings(): void {
    this.postMessage({ type: "costAlertSettings", rules: this.costAlerts.getRules() });
  }

  private pushPricingSettings(): void {
    this.postMessage({ type: "pricingSettings", table: getConfig().pricing.overrides });
  }

  private async savePricingSettings(table: PricingTable): Promise<PricingTable> {
    const validated: PricingTable = {};
    for (const [rawModel, rawRate] of Object.entries(table)) {
      const model = rawModel.trim();
      if (!model || model.startsWith("$")) {
        throw new Error(`Invalid custom model ID: ${rawModel}`);
      }
      validated[model] = validateModelRate(rawRate, model);
    }
    const pricingConfig = vscode.workspace.getConfiguration("tokenWatch");
    const inspected = pricingConfig.inspect<PricingTable>("pricing.overrides");
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await pricingConfig.update(
      "pricing.overrides",
      validated,
      target,
    );
    await this.coordinator.updatePricing(effectivePricingOverrides(validated));
    return validated;
  }

  private pushLanguage(): void {
    this.postMessage({ type: "language", language: this.language.getLanguage() });
  }

  private postMessage(message: HostMessage): void {
    if (!this.disposed) {
      this.view?.webview.postMessage(message);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cacheBust = Date.now().toString(36);

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.js").with({ query: `v=${cacheBust}` }),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.css").with({ query: `v=${cacheBust}` }),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} https: data:;
  ">
  <link rel="stylesheet" href="${styleUri}" />
  <title>Token Watch</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function validateModelRate(rate: ModelRate, model: string): ModelRate {
  const validated: ModelRate = {};
  for (const key of ["inputPer1K", "cachedInputPer1K", "cacheCreationPer1K", "outputPer1K"] as const) {
    const value = rate[key];
    if (value !== undefined) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid ${key} rate for ${model}`);
      }
      validated[key] = value;
    }
  }
  if (validated.inputPer1K === undefined || validated.outputPer1K === undefined) {
    throw new Error(`Input and output rates are required for ${model}`);
  }
  return validated;
}
