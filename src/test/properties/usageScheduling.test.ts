import * as assert from "node:assert";

import { nextRefreshAt } from "../../host/UsageStatusService.js";
import { usageRetryBounds } from "../../shared/usageRetry.js";
import type { UsageCacheInfo } from "../../shared/protocol.js";

/**
 * Whether the quota figures stay live.
 *
 * A provider cache reports `retryAtUtc` for two different reasons — a cooldown
 * lifting after a refusal, and a good response going stale — but only the first
 * carried `retryPending`, and only that one was ever scheduled. A healthy
 * provider was therefore fetched once and then left alone: the numbers froze
 * until someone pressed refresh or reopened the panel, which is the opposite of
 * what a live view is for.
 */
suite("Keeping the quota figures live", () => {
  const NOW = 1_700_000_000_000;

  test("a good response is refreshed again when it goes stale", () => {
    // The case that was broken. No cooldown, nothing pending — just a cached
    // answer with an expiry, which is the normal state of a working provider.
    // Deliberately not 60s: that is also Codex's floor, so the two branches would
    // agree by coincidence and the test would pass either way.
    const expiresAt = NOW + 25_000;
    const cache: UsageCacheInfo = { cachedAtUtc: NOW, retryAtUtc: expiresAt };
    assert.strictEqual(
      nextRefreshAt(cache, "codex", NOW),
      expiresAt,
      "the next refresh belongs at the moment the cached answer expires",
    );
  });

  test("a cooldown after a refusal is respected as-is", () => {
    const cache: UsageCacheInfo = { retryAtUtc: NOW + 12 * 60_000, retryPending: true };
    assert.strictEqual(nextRefreshAt(cache, "claude", NOW), NOW + 12 * 60_000);
  });

  test("having nothing to go on still schedules another attempt", () => {
    // A first call that failed outright leaves no cache and no cooldown. Doing
    // nothing here is how a provider ends up permanently blank.
    for (const provider of ["codex", "claude"] as const) {
      const at = nextRefreshAt({}, provider, NOW);
      assert.strictEqual(
        at,
        NOW + usageRetryBounds(provider).minMs,
        `${provider} should try again after its own spacing`,
      );
      assert.ok(at > NOW, "and it must actually be in the future");
    }
  });

  test("a nonsense expiry does not become a nonsense timer", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const at = nextRefreshAt({ retryAtUtc: bad }, "codex", NOW);
      assert.ok(Number.isFinite(at), `retryAtUtc ${bad} should not survive into the timer`);
      assert.strictEqual(at, NOW + usageRetryBounds("codex").minMs);
    }
  });

  test("Codex comes back sooner than Claude, because it is allowed to", () => {
    const codex = nextRefreshAt({}, "codex", NOW) - NOW;
    const claude = nextRefreshAt({}, "claude", NOW) - NOW;
    assert.ok(
      codex < claude,
      `Codex polls its own endpoint every 60s while Claude wants three minutes: ${codex} vs ${claude}`,
    );
  });
});
