import * as vscode from "vscode";
import { getNonce } from "./utils";
import { isCoordinatorDisposedError, type IngestionCoordinator } from "./host/IngestionCoordinator";
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, isCodexUsageRateLimitError } from "./provider/codex";
import { ClaudeConnection, isClaudeUsageRateLimitError } from "./provider/claude";
import { mapCodexUsageToRateLimitInfo, type CodexUsageResponse } from "./shared/codexUsage";
import { mapClaudeUsageToRateLimitInfo, type ClaudeUsageResponse } from "./shared/claudeUsage";
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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly coordinator: IngestionCoordinator,
    currency: DisplayCurrencyConfig,
  ) {
    this.currency = currency;

    // Subscribe to coordinator data changes → push dataChanged to WebView
    this.disposables.push(
      coordinator.onChanged((freshness) => {
        this.latestFreshness = freshness;
        this.postMessage({ type: "dataChanged" });
        this.pushStatus();
        void this.refreshCodexUsage();
        void this.refreshClaudeUsage();
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
    void this.refreshCodexUsage(true);
    void this.refreshClaudeUsage(true);

    // WebView → host message relay
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewRequest) => {
        this.handleWebviewMessage(message);
      },
      undefined,
      this.disposables,
    );

    this.disposables.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.view = undefined;
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
      });

    this.claudeRateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async refreshCodexUsage(force = false, bypassCache = false): Promise<void> {
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
      });

    this.rateLimitRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private handleWebviewMessage(message: WebviewRequest): void {
    if (this.disposed) {
      return;
    }
    switch (message.type) {
      case "ready":
        // WebView loaded — push initial status
        this.pushStatus();
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
        this.coordinator.updatePricing(message.table);
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
    }
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
