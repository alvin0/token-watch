import * as assert from "node:assert";

import { UsageStatusService } from "../../host/UsageStatusService.js";
import type { CodexConnection } from "../../provider/codex/index.js";
import type { ClaudeConnection } from "../../provider/claude/index.js";
import { usageRetryBounds } from "../../shared/usageRetry.js";

/**
 * The two providers must not drag each other along.
 *
 * They are refreshed from the same three places — the panel becoming visible,
 * the WebView reporting ready, and every data change — and their tolerances are
 * nothing alike: Codex accepts a call a minute, Claude wants three. Coupling
 * them means the livelier one sets the pace for both, and the 429 lands on
 * Claude.
 */
suite("Codex and Claude refresh independently", () => {
  /** Counts what each provider was actually asked for. */
  function fakeConnections() {
    const calls = { codex: 0, claude: 0 };
    const codex = {
      usageInfo: async () => { calls.codex += 1; return {}; },
      limitResets: async () => ({}),
      usageCacheInfo: () => ({}),
    } as unknown as CodexConnection;
    const claude = {
      usageInfo: async () => { calls.claude += 1; return {}; },
      usageCacheInfo: () => ({}),
    } as unknown as ClaudeConnection;
    return { calls, codex, claude };
  }

  function service(connections: { codex: CodexConnection; claude: ClaudeConnection }): UsageStatusService {
    const created = new UsageStatusService(undefined, connections);
    // Refreshing only runs while something is showing the numbers.
    created.setConsumerActive("test", true);
    return created;
  }

  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

  test("refreshing Codex does not fetch Claude", async () => {
    // The question this file exists for. A Codex refresh on its own timer must
    // leave Claude alone, whatever Codex is doing.
    const { calls, codex, claude } = fakeConnections();
    const usage = service({ codex, claude });
    await settle();

    const claudeAfterStart = calls.claude;
    await usage.refresh("codex", { force: true });
    await usage.refresh("codex", { force: true });
    await usage.refresh("codex", { force: true });
    await settle();

    assert.strictEqual(
      calls.claude,
      claudeAfterStart,
      "three Codex refreshes must not have produced a single Claude call",
    );
    assert.ok(calls.codex > claudeAfterStart, "and Codex must actually have been asked");
    usage.dispose();
  });

  test("each provider keeps its own spacing", async () => {
    const { calls, codex, claude } = fakeConnections();
    const usage = service({ codex, claude });
    await settle();

    const afterStart = { ...calls };
    // Unforced, straight away: both are inside their own floor and neither
    // should go out again.
    await usage.refresh("codex");
    await usage.refresh("claude");
    await settle();

    assert.deepStrictEqual(
      calls,
      afterStart,
      "a refresh inside a provider's own spacing must be dropped, not sent",
    );
    assert.ok(
      usageRetryBounds("claude").minMs > usageRetryBounds("codex").minMs,
      "the two floors are different, which is the whole point of keeping them apart",
    );
    usage.dispose();
  });

  test("showing the panel again does not force a fresh pair of calls", async () => {
    // Reopening the sidebar used to force both providers past their floor, so
    // toggling it a few times put several calls through to the one that
    // tolerates the least polling.
    const { calls, codex, claude } = fakeConnections();
    const usage = service({ codex, claude });
    await settle();
    const afterFirstShow = { ...calls };
    assert.ok(afterFirstShow.claude > 0, "the first time round there is nothing cached, so both fetch");

    for (let i = 0; i < 3; i++) {
      usage.setConsumerActive("test", false);
      usage.setConsumerActive("test", true);
      await settle();
    }

    assert.strictEqual(
      calls.claude,
      afterFirstShow.claude,
      "hiding and showing the panel must not re-ask Claude inside its spacing",
    );
    usage.dispose();
  });
});
