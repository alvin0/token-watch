import * as vscode from "vscode";
import { getNonce } from "./utils";
import {
  isCoordinatorDisposedError,
  type CoordinatorHealthState,
  type IngestionCoordinator,
} from "./host/IngestionCoordinator";
import type { CostAlertController } from "./host/CostAlertController";
import type { LanguageController } from "./host/LanguageController";
import type { LimitResetReminder } from "./host/LimitResetReminder";
import { effectivePricingOverrides, getConfig } from "./host/config";
import type { PricingTable } from "./shared/types";
import { validatePricingTableStrict } from "./shared/pricingValidation";
import type {
  WebviewRequest,
  HostMessage,
  AnalyticsThresholds,
  DisplayCurrencyConfig,
  FreshnessInfo,
  WarningInfo,
} from "./shared/protocol";
import { UsageStatusService } from "./host/UsageStatusService";
import { buildSidebarHtml } from "./host/sidebarHtml";

/** Identifies this consumer to the shared usage service. */
const CONSUMER_ID = "sidebar";

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "token-watch.sidebarView";

  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private currency: DisplayCurrencyConfig;
  private analytics: AnalyticsThresholds;
  private readonly usageStatus: UsageStatusService;
  private readonly ownsUsageStatus: boolean;
  private latestFreshness: FreshnessInfo = {};
  private latestWarnings: WarningInfo = {
    unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0, lostUsageLineCount: 0,
  };
  private latestWorkerHealth: CoordinatorHealthState;
  private disposed = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly coordinator: IngestionCoordinator,
    private readonly costAlerts: CostAlertController,
    private readonly language: LanguageController,
    currency: DisplayCurrencyConfig,
    limitResetReminder?: LimitResetReminder,
    analytics: AnalyticsThresholds = { anomalyMultiplier: 2, contextFillWarnPct: 80 },
    private readonly globalStoragePath?: string,
    usageStatus?: UsageStatusService,
  ) {
    this.currency = currency;
    this.analytics = analytics;
    this.latestWorkerHealth = coordinator.healthState();
    this.usageStatus = usageStatus ?? new UsageStatusService(limitResetReminder);
    this.ownsUsageStatus = usageStatus === undefined;

    this.disposables.push(
      coordinator.onChanged(() => {
        this.postMessage({ type: "dataChanged" });
        void this.usageStatus.refresh("codex");
        void this.usageStatus.refresh("claude");
      }),
      coordinator.onScanComplete((freshness) => {
        this.latestFreshness = freshness;
        this.pushStatus();
      }),
      // The worker has always reported these; nothing forwarded them, so the
      // WebView's warnings were permanently the empty defaults.
      coordinator.onWarnings((warnings) => {
        this.latestWarnings = warnings;
        this.pushStatus();
      }),
      coordinator.onHealthChanged((health) => {
        this.latestWorkerHealth = health;
        this.pushStatus();
      }),
      coordinator.onProgress((progress) => {
        this.postMessage({ type: "ingestProgress", processed: progress.processed, total: progress.total, partial: progress.partial });
      }),
      this.usageStatus.onDidChange(() => this.pushStatus()),
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
    this.usageStatus.setConsumerActive(CONSUMER_ID, webviewView.visible);

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
        this.usageStatus.setConsumerActive(CONSUMER_ID, webviewView.visible);
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.usageStatus.setConsumerActive(CONSUMER_ID, false);
        }
      }),
    );
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.view = undefined;
    this.usageStatus.setConsumerActive(CONSUMER_ID, false);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    if (this.ownsUsageStatus) {
      this.usageStatus.dispose();
    }
  }

  /** Push updated currency config to the WebView (called on config change). */
  pushCurrency(currency: DisplayCurrencyConfig): void {
    this.currency = currency;
    this.pushStatus();
  }

  /** Push updated analytics thresholds to the WebView (called on config change). */
  pushAnalytics(analytics: AnalyticsThresholds): void {
    this.analytics = analytics;
    this.pushStatus();
  }

  private pushStatus(): void {
    const usage = this.usageStatus.getState();
    this.postMessage({
      type: "status",
      freshness: this.latestFreshness,
      warnings: this.latestWarnings,
      rateLimit: usage.codexRateLimit,
      claudeRateLimit: usage.claudeRateLimit,
      codexUsageCache: usage.codexUsageCache,
      claudeUsageCache: usage.claudeUsageCache,
      codexPlan: usage.codexPlan,
      claudePlan: usage.claudePlan,
      currency: this.currency,
      analytics: this.analytics,
      workerHealth: {
        status: this.latestWorkerHealth.status,
        ...(this.latestWorkerHealth.message ? { message: this.latestWorkerHealth.message } : {}),
        restarts: this.latestWorkerHealth.restarts,
      },
    });
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
        void this.usageStatus.refresh("codex");
        void this.usageStatus.refresh("claude");
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
        void this.usageStatus.refresh(message.provider, { force: true, bypassCache: true });
        break;
      case "consumeLimitReset":
        if (typeof message.requestId !== "string" || !message.requestId
          || typeof message.resetId !== "string" || !message.resetId) {
          console.warn("[TokenWatch] ignored a usage limit reset activation with an invalid payload");
          break;
        }
        this.usageStatus.consumeCodexLimitReset(message.resetId).then(
          () => this.postMessage({ type: "limitResetConsumed", requestId: message.requestId }),
          (error) => {
            console.warn("[TokenWatch] usage limit reset activation failed:", error);
            const errorMessage = error instanceof Error ? error.message : "Unable to activate the usage limit reset.";
            this.postMessage({ type: "limitResetError", requestId: message.requestId, message: errorMessage });
          },
        );
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
    // Strict: the person is editing these values and should be told what is
    // wrong, rather than having the offending row silently disappear.
    const validated = validatePricingTableStrict(table);
    const pricingConfig = vscode.workspace.getConfiguration("tokenWatch");
    // Always Global: the usage database is global, so prices written into a
    // workspace would silently change other windows' cost history.
    await pricingConfig.update(
      "pricing.overrides",
      validated,
      vscode.ConfigurationTarget.Global,
    );
    await this.coordinator.updatePricing(effectivePricingOverrides(validated, this.globalStoragePath));
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

    return buildSidebarHtml({
      nonce,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      cspSource: webview.cspSource,
      lang: this.language.getLanguage(),
    });
  }
}
