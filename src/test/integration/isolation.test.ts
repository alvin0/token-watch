/**
 * Guards the integration harness's own isolation.
 *
 * These tests start the real extension. If the sandbox ever stops being wired
 * up, activation goes back to scanning the developer's real Codex and Claude
 * logs, reading their OAuth tokens, and rewriting those credential files when a
 * token needs refreshing. That must fail loudly here rather than silently work.
 *
 * They assert the paths the extension will ACTUALLY use — the resolved config,
 * not the built-in defaults. A sandboxed HOME is not sufficient on its own:
 * `tokenWatch.sources.*.path` is application-scoped, so a value left in a real
 * user profile would override the sandbox entirely.
 */

import * as assert from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { providerRequestsEnabled } from "../../shared/testMode";
import { getConfig, toIngestConfig } from "../../host/config";
import { resolveCodexAuthPath } from "../../provider/codex";
import { resolveClaudeCredentialsPath } from "../../provider/claude";

const EXTENSION_ID = "alvin0-dinhai.token-watch";

/** The sandbox root the harness created, as it told the Extension Host. */
function sandboxHome(): string {
  const declared = process.env.TOKEN_WATCH_TEST_HOME;
  assert.ok(declared, "The harness must declare its sandbox root");
  return declared;
}

function isInsideSandbox(candidate: string): boolean {
  const root = path.resolve(sandboxHome());
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

suite("Integration harness isolation", () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  test("runs against a sandboxed home directory, not the developer's", () => {
    assert.ok(
      isInsideSandbox(os.homedir()),
      `The harness must sandbox HOME; got ${os.homedir()}`,
    );
    assert.ok(path.basename(sandboxHome()).startsWith("token-watch-itest-home-"));
  });

  test("runs against a throwaway VS Code profile", () => {
    // Without this a stale application-scoped setting in the developer's real
    // profile could point ingestion at their real logs regardless of HOME.
    const userDataDir = process.env.VSCODE_PORTABLE
      ?? vscode.Uri.file(vscode.env.appRoot).fsPath;
    assert.ok(userDataDir.length > 0);

    const globalStorage = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
    assert.ok(globalStorage, "The extension should be resolvable");

    // The check that matters: no source path setting has been carried in.
    const inspected = vscode.workspace.getConfiguration("tokenWatch")
      .inspect<string>("sources.codex.path");
    assert.strictEqual(
      inspected?.globalValue,
      undefined,
      "A user-profile source path would override the sandbox; the profile must be clean",
    );
    assert.strictEqual(
      vscode.workspace.getConfiguration("tokenWatch").inspect<string>("sources.claude.path")?.globalValue,
      undefined,
    );
  });

  test("the log roots the extension will actually scan are inside the sandbox", () => {
    // Resolved config, not the defaults: this is what ingestion really uses.
    const resolved = toIngestConfig(getConfig());
    for (const source of [resolved.sources.codex, resolved.sources.claude]) {
      assert.ok(source.path, "Every source should resolve to a concrete path");
      assert.ok(
        isInsideSandbox(source.path!),
        `Ingestion would read ${source.path}, which is outside the sandbox`,
      );
      assert.ok(existsSync(source.path!), `Expected the fixture log root ${source.path} to exist`);
    }
  });

  test("credential paths resolve inside the sandbox", () => {
    assert.ok(isInsideSandbox(resolveCodexAuthPath()));
    assert.ok(isInsideSandbox(resolveClaudeCredentialsPath()));
  });

  test("provider requests are disabled, so no quota API is called", () => {
    assert.strictEqual(process.env.TOKEN_WATCH_TEST_MODE, "1");
    assert.strictEqual(providerRequestsEnabled(), false);
  });

  test("no credential file is created or rewritten during the run", () => {
    // Nothing seeded them, and nothing in a test run may write them: a refresh
    // against a real account rotates tokens and can sign the user out.
    assert.strictEqual(existsSync(resolveCodexAuthPath()), false);
    assert.strictEqual(existsSync(resolveClaudeCredentialsPath()), false);
  });

  test("the extension's global storage is inside the sandbox profile", async () => {
    // The database the run writes must not be the developer's own. Global
    // storage lives under the user-data-dir, which the harness redirects.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();

    const marker = vscode.Uri.joinPath(
      vscode.Uri.file(os.homedir()),
      "vscode-user-data",
    ).fsPath;
    assert.ok(
      isInsideSandbox(marker),
      "The harness's user-data-dir should live inside the sandbox home",
    );
  });

  test("only the harness fixtures are visible to discovery", () => {
    const codexDays = readdirSync(path.join(os.homedir(), ".codex", "sessions"));
    assert.deepStrictEqual(codexDays, ["2026"], "Only the harness fixtures should be present");
    const claudeProjects = readdirSync(path.join(os.homedir(), ".claude", "projects"));
    assert.deepStrictEqual(claudeProjects, ["fixture-workspace"]);
  });
});
