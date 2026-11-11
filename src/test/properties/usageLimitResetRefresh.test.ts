import * as assert from "node:assert";

import { UsageStatusService, type UsageAccountLookups } from "../../host/UsageStatusService.js";
import type { CodexRequestOptions, CodexConnection } from "../../provider/codex/index.js";
import type { ClaudeConnection } from "../../provider/claude/index.js";
import { LimitResetNotSpentError } from "../../provider/limitReset.js";

const accounts: UsageAccountLookups = {
  codexAuthMode: async () => "chatgpt",
  codexPlan: async () => undefined,
  claudePlan: async () => undefined,
};

const idleCodex = { usageInfo: async () => ({}), usageCacheInfo: () => ({}) } as unknown as CodexConnection;

/** The re-read after a claim runs on its own; wait for it rather than for the claim. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function claudeUsage(grants: unknown[]) {
  return { five_hour: { utilization: 100 }, cedar_ember: { eligible: true, grants } };
}

suite("Usage limit reset refresh", () => {
  test("fetches fresh Codex usage after an in-flight refresh finishes", async () => {
    const calls: string[] = [];
    const usageOptions: CodexRequestOptions[] = [];
    let releaseFirstUsage = () => {};
    const firstUsage = new Promise<void>((resolve) => { releaseFirstUsage = resolve; });
    let markFirstUsageStarted = () => {};
    const firstUsageStarted = new Promise<void>((resolve) => { markFirstUsageStarted = resolve; });

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
      },
      usageCacheInfo: () => ({}),
    } as unknown as CodexConnection;
    const claude = {
      usageInfo: async () => ({}),
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const service = new UsageStatusService(undefined, { codex, claude, accounts });
    service.setConsumerActive("test", true);
    await firstUsageStarted;

    await service.consumeLimitReset("codex", "credit-abc");
    assert.deepStrictEqual(calls, ["usage", "consume"], "the claim answers without waiting on the re-read");

    releaseFirstUsage();
    await until(() => calls.length === 3, "the re-read");
    assert.deepStrictEqual(calls, ["usage", "consume", "usage"]);
    assert.deepStrictEqual(usageOptions[1], { force: true });
    service.dispose();
  });

  test("hides the spent resets when the re-read after a claim is refused", async () => {
    let usageCalls = 0;
    const claude = {
      usageInfo: async () => {
        usageCalls += 1;
        if (usageCalls > 1) { throw new Error("rate limited"); }
        return claudeUsage([{ id: "grant-1", resets_left: 2, usable_now: true }]);
      },
      consumeLimitReset: async () => undefined,
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const service = new UsageStatusService(undefined, { codex: idleCodex, claude, accounts });
    service.setConsumerActive("test", true);
    await service.refresh("claude", { force: true });
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets?.availableCount, 2);

    await service.consumeLimitReset("claude", "grant-1");
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets, undefined, "hidden as soon as the claim lands");

    await until(() => usageCalls === 2 && !service.getState().claudeUsageCache?.refreshing, "the re-read");
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets, undefined);
    assert.ok(service.getState().claudeRateLimit, "the quota itself stays on screen");
    service.dispose();
  });

  test("a reading that began before the claim does not bring the spent reset back", async () => {
    let usageCalls = 0;
    let releaseStale = () => {};
    const stale = new Promise<void>((resolve) => { releaseStale = resolve; });
    let markStaleStarted = () => {};
    const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve; });
    const claude = {
      usageInfo: async () => {
        usageCalls += 1;
        if (usageCalls === 1) {
          markStaleStarted();
          await stale;
          return claudeUsage([{ id: "grant-1", resets_left: 1, usable_now: true }]);
        }
        throw new Error("rate limited");
      },
      consumeLimitReset: async () => undefined,
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const service = new UsageStatusService(undefined, { codex: idleCodex, claude, accounts });
    service.setConsumerActive("test", true);
    await staleStarted;

    await service.consumeLimitReset("claude", "grant-1");
    releaseStale();
    await until(() => usageCalls === 2 && !service.getState().claudeUsageCache?.refreshing, "the re-read");

    assert.ok(service.getState().claudeRateLimit, "the stale reading's quota is still shown");
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets, undefined);
    service.dispose();
  });

  test("re-reads after a claim whose outcome is unknown", async () => {
    let usageCalls = 0;
    let releaseReread = () => {};
    const reread = new Promise<void>((resolve) => { releaseReread = resolve; });
    const claude = {
      usageInfo: async () => {
        usageCalls += 1;
        if (usageCalls > 1) { await reread; }
        return claudeUsage([{ id: "grant-1", resets_left: 1, usable_now: true }]);
      },
      consumeLimitReset: async () => { throw new Error("timed out"); },
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const service = new UsageStatusService(undefined, { codex: idleCodex, claude, accounts });
    service.setConsumerActive("test", true);
    await service.refresh("claude", { force: true });

    await assert.rejects(service.consumeLimitReset("claude", "grant-1"), /timed out/);
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets, undefined, "hidden until a fresh reading");

    releaseReread();
    await until(() => usageCalls === 2 && !service.getState().claudeUsageCache?.refreshing, "the re-read");
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets?.availableCount, 1);
    service.dispose();
  });

  test("leaves the list and the endpoint alone after a refusal that spent nothing", async () => {
    let usageCalls = 0;
    const claude = {
      usageInfo: async () => {
        usageCalls += 1;
        return claudeUsage([{ id: "grant-1", resets_left: 1, usable_now: true }]);
      },
      consumeLimitReset: async () => { throw new LimitResetNotSpentError("not_limited"); },
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    const service = new UsageStatusService(undefined, { codex: idleCodex, claude, accounts });
    service.setConsumerActive("test", true);
    await service.refresh("claude", { force: true });

    await assert.rejects(service.consumeLimitReset("claude", "grant-1"), /not_limited/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(usageCalls, 1);
    assert.strictEqual(service.getState().claudeRateLimit?.limitResets?.availableCount, 1);
    service.dispose();
  });
});
