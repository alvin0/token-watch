/**
 * Integration tests for the Token Watch extension.
 * Runs in the VS Code test harness via @vscode/test-cli.
 *
 * These assert behaviour that genuinely needs a running Extension Host.
 * Anything that can be checked without one (CSP shape, status bar rendering,
 * watcher rebuild decisions) lives in the pure suites, which run under bare
 * mocha instead of blocking the host.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { getConfig } from "../../host/config";

const EXTENSION_ID = "alvin0-dinhai.token-watch";
const DEBOUNCE_SETTING = "ingestion.watchDebounceMs";

suite("Extension integration tests", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "Extension should be found");
    await ext.activate();
  });

  test("Extension activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "Extension should be found");
    assert.strictEqual(ext.isActive, true, "Extension should be active after activation");
  });

  test("All contributed commands are registered", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const contributed: string[] = (ext.packageJSON.contributes?.commands ?? [])
      .map((command: { command: string }) => command.command);
    assert.ok(contributed.length > 0, "Manifest should contribute commands");

    const registered = await vscode.commands.getCommands(true);
    for (const command of contributed) {
      assert.ok(registered.includes(command), `${command} should be registered`);
    }
    // Registered but intentionally absent from the palette.
    assert.ok(
      registered.includes("token-watch.resetDatabase"),
      "legacy token-watch.resetDatabase alias should be registered",
    );
  });

  test("openPanel reveals the Token Watch view container", async () => {
    // Executes the same command the status bar item is bound to; a failure to
    // reveal rejects, so this exercises the wiring rather than the manifest.
    await vscode.commands.executeCommand("token-watch.openPanel");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  });

  test("showDiagnostics opens a rendered report document", async () => {
    await vscode.commands.executeCommand("token-watch.showDiagnostics");
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "Diagnostics should open a document");
    const text = editor.document.getText();
    assert.ok(
      text.startsWith("# Token Watch Diagnostics"),
      `Diagnostics document should be the rendered report, got: ${text.slice(0, 80)}`,
    );
    assert.ok(text.includes("## Aggregate Integrity"), "Report should include aggregate integrity");
    assert.ok(text.includes("## Pricing"), "Report should include the pricing section");
  });

  test("A settings change is visible to the config reader without a reload", async () => {
    const config = vscode.workspace.getConfiguration("tokenWatch");
    const original = config.inspect<number>(DEBOUNCE_SETTING)?.globalValue;
    const changed = new Promise<void>((resolve) => {
      const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`tokenWatch.${DEBOUNCE_SETTING}`)) {
          subscription.dispose();
          resolve();
        }
      });
    });

    try {
      await config.update(DEBOUNCE_SETTING, 1234, vscode.ConfigurationTarget.Global);
      await changed;
      assert.strictEqual(
        getConfig().ingestion.watchDebounceMs,
        1234,
        "getConfig should read the updated value with no reload",
      );

      // Out-of-range values are clamped, not passed through.
      await vscode.workspace.getConfiguration("tokenWatch")
        .update(DEBOUNCE_SETTING, 10, vscode.ConfigurationTarget.Global);
      assert.strictEqual(getConfig().ingestion.watchDebounceMs, 250, "Below-range values clamp to the minimum");
    } finally {
      await vscode.workspace.getConfiguration("tokenWatch")
        .update(DEBOUNCE_SETTING, original, vscode.ConfigurationTarget.Global);
    }
  });

  test("The sidebar view is contributed as a webview", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const views = ext.packageJSON.contributes?.views?.["token-watch-container"];
    assert.ok(Array.isArray(views), "Views should be defined");
    const sidebarView = views.find((view: { id: string }) => view.id === "token-watch.sidebarView");
    assert.ok(sidebarView, "token-watch.sidebarView should be contributed");
    assert.strictEqual(sidebarView.type, "webview");
  });
});
