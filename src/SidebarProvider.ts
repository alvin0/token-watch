import * as vscode from "vscode";
import { getNonce } from "./utils";
import type { IngestionCoordinator } from "./host/IngestionCoordinator";
import type {
  WebviewRequest,
  HostMessage,
  DisplayCurrencyConfig,
  FreshnessInfo,
  WarningInfo,
} from "./shared/protocol";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "token-watch.sidebarView";

  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private currency: DisplayCurrencyConfig;
  private latestFreshness: FreshnessInfo = {};
  private latestWarnings: WarningInfo = { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0 };

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
      }),
      coordinator.onProgress((progress) => {
        this.postMessage({ type: "ingestProgress", processed: progress.processed, total: progress.total, partial: progress.partial });
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "dist"),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // WebView → host message relay
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewRequest) => {
        this.handleWebviewMessage(message);
      },
      undefined,
      this.disposables,
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
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
      currency: this.currency,
    });
  }

  private handleWebviewMessage(message: WebviewRequest): void {
    switch (message.type) {
      case "ready":
        // WebView loaded — push initial status
        this.pushStatus();
        break;
      case "query":
        this.coordinator.query(message.query).then(
          (result) => {
            this.postMessage({ type: "queryResult", id: message.id, result });
          },
          (err) => {
            // Query failed — log but don't crash
            console.error("[TokenWatch] query error:", err);
            const errorMessage = err instanceof Error ? err.message : "Unknown query error";
            this.postMessage({ type: "queryError", id: message.id, message: errorMessage });
          },
        );
        break;
      case "rescan":
        this.coordinator.rescan();
        break;
      case "resetDatabase":
        vscode.commands.executeCommand("token-watch.resetDatabase");
        break;
      case "updatePricing":
        this.coordinator.updatePricing(message.table);
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
    this.view?.webview.postMessage(message);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist", "webview.css"),
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
