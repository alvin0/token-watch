import * as assert from "node:assert";

import { UsageStatusService, type UsageAccountLookups } from "../../host/UsageStatusService.js";
import type { CodexConnection } from "../../provider/codex/index.js";
import type { ClaudeConnection, ClaudeUsageRequestOptions } from "../../provider/claude/index.js";

/**
 * Several VS Code windows on one machine share a single Claude fetch.
 *
 * When another window shares a response, this one must show it straight away
 * — without waiting out its own timer, and without a request of its own.
 */
suite("Claude usage shared between windows", () => {
  const accounts: UsageAccountLookups = {
    codexAuthMode: async () => "chatgpt",
    codexPlan: async () => undefined,
    claudePlan: async () => undefined,
  };
  const codex = {
    usageInfo: async () => ({}),
    limitResets: async () => ({}),
    usageCacheInfo: () => ({}),
  } as unknown as CodexConnection;
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

  function fakeClaude() {
    const requests: ClaudeUsageRequestOptions[] = [];
    const watch = { onChange: undefined as (() => void) | undefined, stopped: 0 };
    const claude = {
      usageInfo: async (options: ClaudeUsageRequestOptions = {}) => {
        requests.push(options);
        return {};
      },
      usageCacheInfo: () => ({}),
      watchSharedUsage: (onChange: () => void) => {
        watch.onChange = onChange;
        return () => { watch.stopped += 1; };
      },
    } as unknown as ClaudeConnection;
    return { claude, requests, watch };
  }

  test("reads another window's response at once, from the cache", async () => {
    const { claude, requests, watch } = fakeClaude();
    const service = new UsageStatusService(undefined, { codex, claude, accounts });
    service.setConsumerActive("test", true);
    await settle();
    const afterStart = requests.length;

    // Well inside Claude's spacing floor, so only the shared response explains a read.
    watch.onChange?.();
    await settle();

    assert.strictEqual(requests.length, afterStart + 1);
    // Not forced past the cache: the shared response answers it, not the network.
    assert.notStrictEqual(requests[requests.length - 1].force, true);
    service.dispose();
  });

  test("stops watching when nothing shows usage any more", async () => {
    const { claude, watch } = fakeClaude();
    const service = new UsageStatusService(undefined, { codex, claude, accounts });
    service.setConsumerActive("test", true);
    await settle();

    service.setConsumerActive("test", false);
    assert.strictEqual(watch.stopped, 1);

    service.dispose();
    assert.strictEqual(watch.stopped, 1, "dispose must not stop it twice");
  });
});
