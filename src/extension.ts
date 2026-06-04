import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { SidebarProvider } from "./SidebarProvider";
import { IngestionCoordinator } from "./host/IngestionCoordinator";
import { FileWatcher } from "./host/FileWatcher";
import { StatusBarController } from "./host/StatusBarController";
import { getConfig, toIngestConfig, loadPricingFromFile } from "./host/config";

let coordinator: IngestionCoordinator | undefined;
const PERIODIC_SCAN_MS = 2 * 60 * 1000;
const STARTUP_CATCHUP_SCAN_MS = 10_000;

export async function activate(context: vscode.ExtensionContext) {
  const config = getConfig();
  // Load pricing from workspace file (pricing.config.jsonc), merge with VS Code settings
  const filePricing = loadPricingFromFile();
  if (Object.keys(filePricing).length > 0) {
    Object.assign(config.pricing.overrides, filePricing);
  }
  const ingestConfig = toIngestConfig(config);
  const globalStoragePath = context.globalStorageUri.fsPath;

  // Ensure globalStorage directory exists before worker tries to write the db
  const fs = await import("fs");
  if (!fs.existsSync(globalStoragePath)) {
    fs.mkdirSync(globalStoragePath, { recursive: true });
  }

  // Start the ingestion coordinator (spawns worker)
  coordinator = new IngestionCoordinator(globalStoragePath, ingestConfig);
  try {
    await coordinator.start();
  } catch (err) {
    // If worker fails to start, log but don't crash the extension
    console.error("[TokenWatch] Worker failed to start:", err);
    vscode.window.showWarningMessage("Token Watch: Worker failed to start. Some features may be unavailable.");
  }

  // Register the sidebar WebView provider
  const provider = new SidebarProvider(context.extensionUri, coordinator, config.currency);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("token-watch.openPanel", () => {
      vscode.commands.executeCommand("workbench.view.extension.token-watch-container");
    }),
    vscode.commands.registerCommand("token-watch.rescan", () => {
      coordinator?.rescan();
    }),
  );

  // Status bar
  const statusBar = new StatusBarController(coordinator, config.statusBar.enabled);
  context.subscriptions.push(statusBar);

  // File watcher
  const home = os.homedir();
  const watchPaths: string[] = [];
  if (config.sources.codex.enabled) {
    watchPaths.push(config.sources.codex.path || path.join(home, ".codex", "sessions"));
  }
  if (config.sources.claude.enabled) {
    watchPaths.push(config.sources.claude.path || path.join(home, ".claude", "projects"));
  }
  const fileWatcher = new FileWatcher(watchPaths, config.ingestion.watchDebounceMs, (changedPaths) => {
    coordinator?.scanAndIngest("watch", changedPaths);
  });
  context.subscriptions.push(fileWatcher);

  const periodicScan = setInterval(() => {
    coordinator?.scanAndIngest("watch");
  }, PERIODIC_SCAN_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(periodicScan);
    },
  });

  // Config change listener (apply without restart, Req 10.6)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tokenWatch")) {
        const newConfig = getConfig();
        statusBar.setEnabled(newConfig.statusBar.enabled);
        // Re-push currency to WebView when secondary currency changes
        if (e.affectsConfiguration("tokenWatch.currency")) {
          provider.pushCurrency(newConfig.currency);
        }
        // Pricing changes trigger recompute
        if (e.affectsConfiguration("tokenWatch.pricing")) {
          coordinator?.updatePricing(newConfig.pricing.overrides);
        }
      }
    }),
  );

  // Trigger startup scans: one immediately, one shortly after VS Code settles.
  coordinator.scanAndIngest("activation");
  const startupCatchupScan = setTimeout(() => {
    coordinator?.scanAndIngest("watch");
  }, STARTUP_CATCHUP_SCAN_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(startupCatchupScan);
    },
  });

  // Push coordinator to subscriptions for dispose
  context.subscriptions.push(coordinator);
}

export function deactivate() {
  // Coordinator dispose handles flush + terminate
}
