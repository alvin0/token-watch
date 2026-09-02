import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";

import { watchRootsFor, watchTargetsChanged } from "../../extension.js";
import { UsageStatusService } from "../../host/UsageStatusService.js";
import type { TokenWatchConfig } from "../../host/config.js";

function config(overrides: Partial<TokenWatchConfig> = {}): TokenWatchConfig {
  return {
    sources: {
      codex: { enabled: true, path: "" },
      claude: { enabled: true, path: "" },
    },
    pricing: { overrides: {} },
    currency: {},
    ingestion: { watchDebounceMs: 500, maxLineBytes: 1_048_576, backfillMonths: 0 },
    retention: { rawRecordDays: 0 },
    analytics: { anomalyMultiplier: 2, contextFillWarnPct: 80 },
    statusBar: { enabled: true },
    ...overrides,
  };
}

suite("Watcher reacts to settings without a reload", () => {
  test("defaults resolve to the two known log roots", () => {
    const roots = watchRootsFor(config());
    assert.deepStrictEqual(roots, [
      path.join(os.homedir(), ".codex", "sessions"),
      path.join(os.homedir(), ".claude", "projects"),
    ]);
  });

  test("a disabled source drops its root", () => {
    const roots = watchRootsFor(config({
      sources: { codex: { enabled: false, path: "" }, claude: { enabled: true, path: "" } },
    }));
    assert.deepStrictEqual(roots, [path.join(os.homedir(), ".claude", "projects")]);
  });

  test("a custom path replaces the default", () => {
    const roots = watchRootsFor(config({
      sources: { codex: { enabled: true, path: "/custom/codex" }, claude: { enabled: false, path: "" } },
    }));
    assert.deepStrictEqual(roots, ["/custom/codex"]);
  });

  test("an unrelated change does not rebuild the watcher", () => {
    const before = config();
    const after = config({ statusBar: { enabled: false } });
    assert.strictEqual(watchTargetsChanged(before, after), false);
  });

  test("toggling a source rebuilds the watcher", () => {
    const before = config();
    const after = config({
      sources: { codex: { enabled: false, path: "" }, claude: { enabled: true, path: "" } },
    });
    assert.strictEqual(watchTargetsChanged(before, after), true);
  });

  test("changing a source path rebuilds the watcher", () => {
    const before = config();
    const after = config({
      sources: { codex: { enabled: true, path: "/elsewhere" }, claude: { enabled: true, path: "" } },
    });
    assert.strictEqual(watchTargetsChanged(before, after), true);
  });

  test("changing the debounce rebuilds the watcher", () => {
    const before = config();
    const after = config({ ingestion: { watchDebounceMs: 2000, maxLineBytes: 1_048_576, backfillMonths: 0 } });
    assert.strictEqual(watchTargetsChanged(before, after), true);
  });
});

suite("Usage status service gating", () => {
  test("no consumer means no refreshing", async () => {
    const service = new UsageStatusService();
    assert.strictEqual(service.isActive(), false);
    // Resolves immediately without touching the network.
    await service.refresh("codex");
    await service.refresh("claude");
    assert.deepStrictEqual(service.getState(), { codexUnavailable: false, claudeUnavailable: false });
    service.dispose();
  });

  test("a consumer activates the service and deactivating it stops again", () => {
    const service = new UsageStatusService();
    service.setConsumerActive("sidebar", true);
    assert.strictEqual(service.isActive(), true);
    service.setConsumerActive("sidebar", false);
    assert.strictEqual(service.isActive(), false);
    service.dispose();
  });

  test("the service stays active while any consumer still shows usage", () => {
    const service = new UsageStatusService();
    service.setConsumerActive("sidebar", true);
    service.setConsumerActive("statusBar", true);
    service.setConsumerActive("sidebar", false);
    assert.strictEqual(service.isActive(), true, "The status bar is still showing the numbers");
    service.setConsumerActive("statusBar", false);
    assert.strictEqual(service.isActive(), false);
    service.dispose();
  });

  test("a disposed service is never active again", () => {
    const service = new UsageStatusService();
    service.setConsumerActive("sidebar", true);
    service.dispose();
    assert.strictEqual(service.isActive(), false);
  });
});
