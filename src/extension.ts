import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { SidebarProvider } from "./SidebarProvider";
import { IngestionCoordinator } from "./host/IngestionCoordinator";
import { FileWatcher } from "./host/FileWatcher";
import { StatusBarController } from "./host/StatusBarController";
import { getConfig, toIngestConfig, loadPricingFromFile } from "./host/config";
import type { DiagnosticsReport } from "./shared/protocol";

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
    vscode.commands.registerCommand("token-watch.resetDatabase", async () => {
      const confirmed = await vscode.window.showWarningMessage(
        "Token Watch: Reset database? This clears all stored token data and cursors, then rebuilds from logs.",
        { modal: true },
        "Reset",
      );
      if (confirmed === "Reset") {
        coordinator?.resetDatabase();
      }
    }),
    vscode.commands.registerCommand("token-watch.showDiagnostics", async () => {
      if (!coordinator) {
        vscode.window.showWarningMessage("Token Watch: worker is not available.");
        return;
      }
      try {
        const report = await coordinator.diagnostics();
        const doc = await vscode.workspace.openTextDocument({
          content: renderDiagnosticsReport(report),
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        vscode.window.showErrorMessage(`Token Watch diagnostics failed: ${message}`);
      }
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

function renderDiagnosticsReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("# Token Watch Diagnostics");
  lines.push("");
  lines.push(`Generated: ${new Date(report.generatedAtUtc).toLocaleString()}`);
  lines.push("");

  lines.push("## Pricing");
  lines.push(`Ignored known-model overrides: ${listOrNone(report.pricing.ignoredKnownModelOverrides)}`);
  lines.push(`Ignored $fallback override: ${report.pricing.ignoredFallbackOverride ? "yes" : "no"}`);
  lines.push(`Custom model overrides: ${listOrNone(report.pricing.customModelOverrides)}`);
  lines.push("");

  lines.push("## Long Context");
  lines.push(`Threshold: ${report.longContext.thresholdTokens.toLocaleString()} input/context tokens`);
  lines.push("");
  lines.push("Applied:");
  lines.push(...table(
    ["Model", "Effective", "Sessions", "Turns", "Max context"],
    report.longContext.applied.map((row) => [
      row.model,
      row.effectiveModel ?? "",
      row.sessions,
      row.turns,
      row.maxContextUsedTokens.toLocaleString(),
    ]),
  ));
  lines.push("");
  lines.push("Missing rates:");
  lines.push(...table(
    ["Model", "Sessions", "Turns", "Max context"],
    report.longContext.missingRates.map((row) => [
      row.model,
      row.sessions,
      row.turns,
      row.maxContextUsedTokens.toLocaleString(),
    ]),
  ));
  lines.push("");

  lines.push("## Crossing Midnight Sessions");
  lines.push(...table(
    ["Source", "Session", "First day", "Last day", "Tokens", "Cost"],
    report.crossingMidnightSessions.map((row) => [
      row.source,
      shortId(row.sessionId),
      row.firstDay,
      row.lastDay,
      row.totalTokens.toLocaleString(),
      fmtUsd(row.costUsd),
    ]),
  ));
  lines.push("");

  lines.push("## Event Day vs Folder Day");
  lines.push(...table(
    ["Day", "Event cost", "Folder cost", "Delta"],
    report.folderDayComparison.map((row) => [
      row.day,
      fmtUsd(row.eventCostUsd),
      fmtUsd(row.folderCostUsd),
      fmtUsd(row.deltaUsd),
    ]),
  ));
  lines.push("");
  lines.push("Mismatched files:");
  lines.push(...table(
    ["Folder day", "Event days", "Cost", "File"],
    report.folderDayMismatches.map((row) => [
      row.folderDay,
      row.eventDays.join(", "),
      fmtUsd(row.costUsd),
      row.filePath,
    ]),
  ));
  lines.push("");

  lines.push("## Reconciliation");
  lines.push(`Checked Codex file sessions: ${report.reconciliation.checkedSessions}`);
  lines.push(...table(
    ["Session", "Final total", "Ingested total", "Delta", "File"],
    report.reconciliation.mismatches.map((row) => [
      shortId(row.sessionId),
      row.finalTotalTokens.toLocaleString(),
      row.ingestedTotalTokens.toLocaleString(),
      row.deltaTokens.toLocaleString(),
      row.filePath,
    ]),
  ));
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function table(headers: string[], rows: Array<Array<string | number>>): string[] {
  if (rows.length === 0) {
    return ["_None_"];
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(String).join(" | ")} |`),
  ];
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}
