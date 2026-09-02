import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { SidebarProvider } from "./SidebarProvider";
import { IngestionCoordinator } from "./host/IngestionCoordinator";
import { FileWatcher } from "./host/FileWatcher";
import { StatusBarController } from "./host/StatusBarController";
import { CostAlertController } from "./host/CostAlertController";
import { LimitResetReminder } from "./host/LimitResetReminder";
import { LanguageController } from "./host/LanguageController";
import { UsageStatusService } from "./host/UsageStatusService";
import { effectivePricingOverrides, getConfig, toIngestConfig, type TokenWatchConfig } from "./host/config";
import type { DiagnosticsReport } from "./shared/protocol";
import { PRUNED_SCHEMA_VERSION, SCHEMA_VERSION } from "./worker/store/schema";

let coordinator: IngestionCoordinator | undefined;
const PERIODIC_SCAN_MS = 2 * 60 * 1000;
const STARTUP_CATCHUP_SCAN_MS = 10_000;

export async function activate(context: vscode.ExtensionContext) {
  const globalStoragePath = context.globalStorageUri.fsPath;

  // Ensure globalStorage directory exists before worker tries to write the db
  const fs = await import("fs");
  if (!fs.existsSync(globalStoragePath)) {
    fs.mkdirSync(globalStoragePath, { recursive: true });
  }

  let config = getConfig();
  config.pricing.overrides = effectivePricingOverrides(config.pricing.overrides, globalStoragePath);
  const ingestConfig = toIngestConfig(config);

  // Start the ingestion coordinator (spawns worker)
  coordinator = new IngestionCoordinator(globalStoragePath, ingestConfig);
  try {
    await coordinator.start();
  } catch (err) {
    // A failed START is terminal until the user asks again — unlike a crash
    // after startup, nothing retries it — so say that rather than promising a
    // background retry that never comes.
    console.error("[TokenWatch] Worker failed to start:", err);
    void vscode.window.showWarningMessage(
      'Token Watch: the ingestion worker did not start, so usage data will not update. ' +
      'Run "Token Watch: Rescan Logs" to try again.',
    );
  }

  // Cost alerts run in the extension host so notifications still work while the sidebar is closed.
  const language = new LanguageController(context.globalState);
  const costAlerts = new CostAlertController(
    coordinator,
    context.globalState,
    undefined,
    () => language.getLanguage(),
  );
  costAlerts.start();
  context.subscriptions.push(costAlerts);

  // Reminds the user before a Codex usage limit reset expires unused.
  const limitResetReminder = new LimitResetReminder(
    context.globalState,
    undefined,
    () => language.getLanguage(),
  );

  // One owner of provider quota state; the sidebar and status bar both read it.
  const usageStatus = new UsageStatusService(limitResetReminder);
  context.subscriptions.push(usageStatus);

  // Register the sidebar WebView provider
  const provider = new SidebarProvider(
    context.extensionUri,
    coordinator,
    costAlerts,
    language,
    config.currency,
    limitResetReminder,
    config.analytics,
    globalStoragePath,
    usageStatus,
  );
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, provider),
  );

  // Register commands
  const resetDatabase = async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "Token Watch: Reset database? This clears all stored token data and cursors, then rebuilds from logs.",
      { modal: true },
      "Reset",
    );
    if (confirmed !== "Reset") { return; }
    if (!coordinator) {
      void vscode.window.showWarningMessage("Token Watch: worker is not available.");
      return;
    }
    try {
      const records = await coordinator.resetDatabase();
      void vscode.window.showInformationMessage(
        `Token Watch: database reset. ${records.toLocaleString()} usage records rebuilt from your logs.`,
      );
    } catch (error) {
      // The reset used to be fire-and-forget: a failure only reached the log,
      // and the user was left believing it had worked.
      const message = error instanceof Error ? error.message : "Unknown error";
      void vscode.window.showErrorMessage(`Token Watch: database reset failed. ${message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("token-watch.openPanel", () => {
      vscode.commands.executeCommand("workbench.view.extension.token-watch-container");
    }),
    vscode.commands.registerCommand("token-watch.rescan", () => {
      coordinator?.rescan();
    }),
    vscode.commands.registerCommand("token-watch:resetdb", resetDatabase),
    // Backwards-compatible alias for existing keybindings and integrations.
    vscode.commands.registerCommand("token-watch.resetDatabase", resetDatabase),
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
  const statusBar = new StatusBarController(coordinator, config.statusBar.enabled, language, usageStatus);
  context.subscriptions.push(statusBar);

  // File watcher. Rebuilt in place when the watched roots or the debounce
  // change, so those settings no longer need a window reload.
  let fileWatcher = createFileWatcher(config);
  context.subscriptions.push({ dispose: () => fileWatcher.dispose() });

  const periodicScan = setInterval(() => {
    coordinator?.scanAndIngest("watch");
  }, PERIODIC_SCAN_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(periodicScan);
    },
  });

  // Surface a worker that has stopped for good; otherwise the panel silently
  // stops updating and there is nothing anywhere saying why.
  let reportedWorkerFailure = false;
  context.subscriptions.push(
    coordinator.onHealthChanged((health) => {
      if (health.status === "failed" && !reportedWorkerFailure) {
        reportedWorkerFailure = true;
        void vscode.window.showWarningMessage(
          `Token Watch: ingestion stopped. ${health.message ?? "The worker could not be started."} Run "Token Watch: Rescan Logs" to try again.`,
        );
      }
      if (health.status === "ready") {
        reportedWorkerFailure = false;
      }
    }),
  );

  // Config change listener (apply without restart, Req 10.6)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("tokenWatch")) {
        return;
      }
      const newConfig = getConfig();
      newConfig.pricing.overrides = effectivePricingOverrides(newConfig.pricing.overrides, globalStoragePath);
      const previous = config;
      config = newConfig;

      statusBar.setEnabled(newConfig.statusBar.enabled);
      if (e.affectsConfiguration("tokenWatch.currency")) {
        provider.pushCurrency(newConfig.currency);
      }
      if (e.affectsConfiguration("tokenWatch.analytics")) {
        provider.pushAnalytics(newConfig.analytics);
      }
      if (e.affectsConfiguration("tokenWatch.pricing")) {
        void coordinator?.updatePricing(newConfig.pricing.overrides).catch((error) => {
          console.error("[TokenWatch] pricing update failed:", error);
        });
      }

      // Source toggles/paths and ingestion limits used to need a reload: the
      // worker only ever saw the config captured at activation.
      if (e.affectsConfiguration("tokenWatch.sources") || e.affectsConfiguration("tokenWatch.ingestion")) {
        void coordinator?.updateConfig(toIngestConfig(newConfig)).catch((error) => {
          console.error("[TokenWatch] config update failed:", error);
        });
      }
      if (watchTargetsChanged(previous, newConfig)) {
        fileWatcher.dispose();
        fileWatcher = createFileWatcher(newConfig);
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

export async function deactivate(): Promise<void> {
  // Awaited by VS Code, so the worker's final snapshot is written before the
  // thread is terminated. dispose() alone could only fire-and-forget.
  const active = coordinator;
  coordinator = undefined;
  const result = await active?.shutdown();
  if (result && !result.persisted) {
    // Nothing can be shown at this point in the lifecycle, but the reason
    // belongs in the log rather than nowhere.
    console.error(`[TokenWatch] usage data may be out of date on next start: ${result.reason ?? "the final write failed"}`);
  }
}

/** Directories the watcher follows for the given config. */
export function watchRootsFor(cfg: TokenWatchConfig): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (cfg.sources.codex.enabled) {
    roots.push(cfg.sources.codex.path || path.join(home, ".codex", "sessions"));
  }
  if (cfg.sources.claude.enabled) {
    roots.push(cfg.sources.claude.path || path.join(home, ".claude", "projects"));
  }
  return roots;
}

function createFileWatcher(cfg: TokenWatchConfig): FileWatcher {
  return new FileWatcher(watchRootsFor(cfg), cfg.ingestion.watchDebounceMs, (changedPaths) => {
    coordinator?.scanAndIngest("watch", changedPaths);
  });
}

/** Whether a config change means the watcher must be torn down and rebuilt. */
export function watchTargetsChanged(previous: TokenWatchConfig, next: TokenWatchConfig): boolean {
  const before = watchRootsFor(previous);
  const after = watchRootsFor(next);
  return (
    previous.ingestion.watchDebounceMs !== next.ingestion.watchDebounceMs ||
    before.length !== after.length ||
    before.some((root, index) => root !== after[index])
  );
}

function renderDiagnosticsReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("# Token Watch Diagnostics");
  lines.push("");
  lines.push(`Generated: ${new Date(report.generatedAtUtc).toLocaleString()}`);
  lines.push("");

  lines.push("## Aggregate Integrity");
  lines.push(`Valid: ${report.aggregate.valid ? "yes" : "no"}`);
  lines.push(`Fallback rebuilds: ${report.aggregate.fallbackCount}`);
  lines.push(`Algorithm version: ${report.aggregate.algorithmVersion ?? "unknown"}`);
  lines.push("");

  lines.push("## Pricing");
  lines.push(`Overridden bundled models: ${listOrNone(report.pricing.overriddenBundledModels)}`);
  lines.push(`Ignored $fallback override: ${report.pricing.ignoredFallbackOverride ? "yes" : "no"}`);
  lines.push(`Custom model overrides: ${listOrNone(report.pricing.customModelOverrides)}`);
  lines.push(`Models seen with no rate: ${listOrNone(report.pricing.unmappedModels ?? [])}`);
  lines.push("Their tokens are counted in full; only their cost reads low.");
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

  lines.push("## Ingestion Quality");
  const { ingestion } = report;
  const missing = ingestion.malformedLineCount + ingestion.lostUsageLineCount;
  lines.push(missing === 0
    ? "Tokens missing from the totals: none. Every line carrying token counts was read."
    : `Tokens missing from the totals: ${missing.toLocaleString()} line(s) could not be read.`);
  lines.push(`Lines that could not be parsed: ${ingestion.malformedLineCount.toLocaleString()}`);
  lines.push(`Lines too large to read, holding token counts: ${ingestion.lostUsageLineCount.toLocaleString()}`);
  lines.push(`Oversized lines read anyway because they held token counts: ${ingestion.oversizedRecoveredCount.toLocaleString()}`);
  lines.push(`Oversized lines skipped, holding no token counts: ${ingestion.oversizedLineCount.toLocaleString()}`);
  lines.push("");

  lines.push("## Timing");
  const { timing } = report;
  lines.push(`Worker up for ${(timing.upMs / 1000).toFixed(1)}s`);
  lines.push("");
  // The first thing to look at when the panel felt stuck: while the worker is
  // inside one of these it cannot answer anything, however fast the query is.
  if (timing.stalls.length === 0) {
    lines.push("Longest the worker went without answering: nothing over 0.4s.");
  } else {
    lines.push("Longest the worker went without answering:");
    lines.push(...table(
      ["Blocked for", "At"],
      timing.stalls.slice(0, 8).map((stall) => [
        `${(stall.ms / 1000).toFixed(1)}s`,
        `${(stall.atMs / 1000).toFixed(1)}s in`,
      ]),
    ));
  }
  lines.push("");

  const slowest = [...timing.spans].sort((a, b) => b.ms - a.ms).slice(0, 15);
  if (slowest.length > 0) {
    lines.push("Slowest steps:");
    lines.push(...table(
      ["Step", "Took", "At", "Detail"],
      slowest.map((span) => [
        span.name,
        span.ms >= 1000 ? `${(span.ms / 1000).toFixed(1)}s` : `${span.ms} ms`,
        `${(span.atMs / 1000).toFixed(1)}s in`,
        span.detail ?? "",
      ]),
    ));
    lines.push("");
  }

  lines.push("## Retention");
  const { retention } = report;
  lines.push(retention.retainedFromDay === undefined
    ? "Per-turn detail: kept for every day (tokenWatch.retention.rawRecordDays is 0)."
    : `Per-turn detail: kept from ${retention.retainedFromDay} onwards.`);
  lines.push(`Per-turn rows stored: ${retention.rawRecordCount.toLocaleString()}`);
  lines.push("Daily and per-session totals are kept for every day regardless, so the");
  lines.push("dashboard history is complete. Pruned days lose only the hourly drill-down,");
  lines.push("the tool-call detail, and the ability to reprice them.");
  lines.push("");
  // The first thing to look at when a window says it cannot open the database.
  lines.push(`Database schema: ${retention.schemaVersion}`);
  // Each number locks out a different generation for a different reason, so
  // say which one, rather than a single sentence that is wrong for the other.
  if (retention.schemaVersion >= PRUNED_SCHEMA_VERSION) {
    lines.push("Builds that predate retention will refuse to open this database: they");
    lines.push("would rebuild the kept totals from records it no longer has, deleting the");
    lines.push("history. Reset the database to undo that mark.");
  }
  if (retention.schemaVersion >= SCHEMA_VERSION) {
    lines.push("Builds that predate compact dedup keys will refuse to open it too: they");
    lines.push("would insert a second copy of every turn they re-read. Reload any window");
    lines.push("still running one. This mark is permanent; a reset does not remove it.");
  } else {
    lines.push("Every release of this extension can open this database.");
  }
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
