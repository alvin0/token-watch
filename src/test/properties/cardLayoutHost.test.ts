import * as assert from "node:assert";
import * as vscode from "vscode";

import { SidebarProvider } from "../../SidebarProvider.js";
import { UsageStatusService, type UsageAccountLookups } from "../../host/UsageStatusService.js";
import type { IngestionCoordinator } from "../../host/IngestionCoordinator.js";
import type { CostAlertController } from "../../host/CostAlertController.js";
import type { LanguageController } from "../../host/LanguageController.js";
import type { CodexConnection } from "../../provider/codex/index.js";
import type { ClaudeConnection } from "../../provider/claude/index.js";
import { DEFAULT_CARD_ORDER, resolveCardLayout } from "../../shared/cardLayout.js";
import type { HostMessage, WebviewRequest } from "../../shared/protocol.js";

/**
 * Hiding the usage cards stops the panel asking for provider usage, but not
 * the status bar: it is a consumer of its own and keeps showing the numbers.
 */
suite("Card layout in the host", () => {
  const noop = () => ({ dispose() {} });
  const coordinator = {
    onChanged: noop, onScanComplete: noop, onWarnings: noop, onHealthChanged: noop, onProgress: noop,
    healthState: () => ({ status: "ready", restarts: 0 }),
  } as unknown as IngestionCoordinator;
  const costAlerts = { getRules: () => [] } as unknown as CostAlertController;
  const language = { getLanguage: () => "en" } as unknown as LanguageController;
  const hideBothUsageCards = resolveCardLayout({
    today: [{ id: "codexUsage", visible: false }, { id: "claudeUsage", visible: false }],
  });

  function fakeUsage() {
    const consumers = new Map<string, boolean>();
    const usage = {
      setConsumerActive: (id: string, active: boolean) => { consumers.set(id, active); },
      onDidChange: noop,
      getState: () => ({ codexUnavailable: false, claudeUnavailable: false }),
      refresh: async () => undefined,
    } as unknown as UsageStatusService;
    return { usage, consumers };
  }

  function openPanel(provider: SidebarProvider) {
    const posted: HostMessage[] = [];
    let receive: (message: WebviewRequest) => void = () => {};
    const view = {
      visible: true,
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async (message: HostMessage) => { posted.push(message); return true; },
        onDidReceiveMessage: (listener: (message: WebviewRequest) => void) => { receive = listener; return { dispose() {} }; },
      },
      onDidChangeVisibility: noop,
      onDidDispose: noop,
    } as unknown as vscode.WebviewView;
    provider.resolveWebviewView(view);
    return { posted, send: (message: WebviewRequest) => receive(message) };
  }

  function sidebar(usage: UsageStatusService): SidebarProvider {
    return new SidebarProvider(
      vscode.Uri.file("/extension"), coordinator, costAlerts, language, {}, undefined, undefined, undefined, usage,
    );
  }

  test("the panel stops asking for usage once both usage cards are hidden", () => {
    const { usage, consumers } = fakeUsage();
    const provider = sidebar(usage);
    openPanel(provider);
    assert.strictEqual(consumers.get("sidebar"), true);

    provider.pushCardLayout(hideBothUsageCards);
    assert.strictEqual(consumers.get("sidebar"), false);

    provider.pushCardLayout(resolveCardLayout({ today: [{ id: "codexUsage", visible: false }] }));
    assert.strictEqual(consumers.get("sidebar"), true, "one usage card left is still a reason to fetch");
    provider.dispose();
  });

  test("the status bar keeps usage fetching with the cards hidden", async () => {
    let fetches = 0;
    const accounts: UsageAccountLookups = {
      codexAuthMode: async () => "chatgpt",
      codexPlan: async () => undefined,
      claudePlan: async () => undefined,
    };
    const service = new UsageStatusService(undefined, {
      accounts,
      codex: {
        usageInfo: async () => { fetches += 1; return {}; },
        usageCacheInfo: () => ({}),
        watchSharedUsage: () => () => undefined,
      } as unknown as CodexConnection,
      claude: {
        usageInfo: async () => { fetches += 1; return {}; },
        usageCacheInfo: () => ({}),
        watchSharedUsage: () => () => undefined,
      } as unknown as ClaudeConnection,
    });
    service.setConsumerActive("statusBar", true);
    const provider = sidebar(service);
    openPanel(provider);
    provider.pushCardLayout(hideBothUsageCards);
    // Let the refreshes that starting up queued finish before counting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    fetches = 0;

    await service.refresh("claude", { force: true });
    assert.strictEqual(fetches, 1, "the status bar is still showing usage, so it is still fetched");
    provider.dispose();
    service.dispose();
  });

  test("a saved layout is resolved before it is written, globally", async () => {
    const { usage } = fakeUsage();
    const provider = sidebar(usage);
    const panel = openPanel(provider);
    const writes: Array<{ key: string; value: unknown; target: unknown }> = [];
    const original = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: (_key: string, fallback: unknown) => fallback,
      update: async (key: string, value: unknown, target: unknown) => { writes.push({ key, value, target }); },
    });
    try {
      panel.send({
        type: "saveCardLayout",
        requestId: "card-layout-save-1",
        // What the dialog sends: the whole tab, here with Tool calls moved first and hidden.
        layout: {
          today: [
            { id: "toolCalls", visible: false },
            { id: "notACard", visible: true },
            ...DEFAULT_CARD_ORDER.today.filter((id) => id !== "toolCalls").map((id) => ({ id, visible: true })),
          ],
        } as never,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = original;
    }

    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, "layout.cards");
    assert.strictEqual(writes[0].target, vscode.ConfigurationTarget.Global);
    const saved = writes[0].value as ReturnType<typeof resolveCardLayout>;
    assert.deepStrictEqual(saved.today[0], { id: "toolCalls", visible: false });
    assert.ok(!saved.today.some((slot) => (slot.id as string) === "notACard"));
    assert.ok(panel.posted.some((message) => message.type === "cardLayoutSaved"));
    provider.dispose();
  });
});
