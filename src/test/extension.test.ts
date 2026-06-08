import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "alvin0-dinhai.token-watch";

suite("Token Watch Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Command is registered", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "Extension should be found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("token-watch.openPanel"));
    assert.ok(commands.includes("token-watch.rescan"));
    assert.ok(commands.includes("token-watch.resetDatabase"));
    assert.ok(commands.includes("token-watch.showDiagnostics"));
  });

  test("Configuration default", () => {
    const config = vscode.workspace.getConfiguration("tokenWatch");
    assert.strictEqual(config.get("sources.codex.enabled"), true);
    assert.strictEqual(config.get("sources.claude.enabled"), true);
    assert.strictEqual(config.get("ingestion.watchDebounceMs"), 500);
  });
});
