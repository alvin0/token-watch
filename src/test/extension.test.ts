import * as assert from "assert";
import * as vscode from "vscode";

suite("Token Watch Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("token-watch.helloWorld"));
  });

  test("Configuration default", () => {
    const config = vscode.workspace.getConfiguration("tokenWatch");
    assert.strictEqual(config.get("enabled"), true);
  });
});
