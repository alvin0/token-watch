import * as assert from "node:assert";

import { UsageStatusService, type UsageAccountLookups } from "../../host/UsageStatusService.js";
import type { CodexRequestOptions, CodexConnection } from "../../provider/codex/index.js";
import type { ClaudeConnection } from "../../provider/claude/index.js";

suite("Usage limit reset refresh", () => {
  test("fetches fresh Codex usage after an in-flight refresh finishes", async () => {
    const calls: string[] = [];
    const usageOptions: CodexRequestOptions[] = [];
    let releaseFirstUsage = () => {};
    const firstUsage = new Promise<void>((resolve) => { releaseFirstUsage = resolve; });
    let markFirstUsageStarted = () => {};
    const firstUsageStarted = new Promise<void>((resolve) => { markFirstUsageStarted = resolve; });
    let markConsumeStarted = () => {};
    const consumeStarted = new Promise<void>((resolve) => { markConsumeStarted = resolve; });

    const codex = {
      usageInfo: async (options: CodexRequestOptions = {}) => {
        calls.push("usage");
        usageOptions.push(options);
        if (usageOptions.length === 1) {
          markFirstUsageStarted();
          await firstUsage;
        }
        return {};
      },
      consumeLimitReset: async () => {
        calls.push("consume");
        markConsumeStarted();
      },
      usageCacheInfo: () => ({}),
    } as unknown as CodexConnection;
    const claude = {
      usageInfo: async () => ({}),
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const accounts: UsageAccountLookups = {
      codexAuthMode: async () => "chatgpt",
      codexPlan: async () => undefined,
      claudePlan: async () => undefined,
    };
    const service = new UsageStatusService(undefined, { codex, claude, accounts });
    service.setConsumerActive("test", true);
    await firstUsageStarted;

    const activation = service.consumeCodexLimitReset("credit-abc");
    await consumeStarted;
    releaseFirstUsage();
    await activation;

    assert.deepStrictEqual(calls, ["usage", "consume", "usage"]);
    assert.deepStrictEqual(usageOptions[1], { force: true });
    service.dispose();
  });
});
