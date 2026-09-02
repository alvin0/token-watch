import * as assert from "assert";
import {
  MAX_RATE_LIMIT_BACKOFF_MS,
  MAX_USAGE_RETRY_MS,
  MIN_USAGE_RETRY_MS,
  randomUsageRetryMs,
  rateLimitBackoffMs,
  usageRetryBounds,
} from "../../shared/usageRetry.js";

suite("Usage retry interval", () => {
  test("each provider is asked as often as it allows, and no more", () => {
    // The two services do not want the same cadence, and a single figure for
    // both was wrong in both directions: Codex figures went stale for minutes
    // when 30 seconds was allowed, while Claude was polled faster than it wants.
    const codex = usageRetryBounds("codex");
    const claude = usageRetryBounds("claude");

    // The official Codex TUI polls this endpoint on a 60-second interval
    // (openai/codex#10869); matching the first-party client is the safe bet.
    assert.strictEqual(codex.minMs, 60_000, "Codex matches what its own client does");
    // 30-60s earns persistent 429s and the endpoint sends no Retry-After
    // (anthropics/claude-code#31637); 180s is where community tools settled
    // (Maciek-roboblog/Claude-Code-Usage-Monitor#202).
    assert.ok(
      claude.minMs >= 180_000,
      `Claude needs at least three minutes, got ${claude.minMs} ms`,
    );
    assert.ok(
      claude.maxMs <= 240_000,
      `and should not drift far past it, got ${claude.maxMs} ms`,
    );
    assert.ok(codex.maxMs < claude.minMs, "Codex should always be the livelier of the two");
  });

  test("the wait lands inside the provider's range, ends included", () => {
    for (const provider of ["codex", "claude"] as const) {
      const { minMs, maxMs } = usageRetryBounds(provider);
      assert.strictEqual(randomUsageRetryMs(provider, () => 0), minMs);
      assert.strictEqual(randomUsageRetryMs(provider, () => 0.999999), maxMs);
      const middle = randomUsageRetryMs(provider, () => 0.5);
      assert.ok(middle > minMs && middle < maxMs, `${provider}: ${middle} should sit between`);
    }
  });

  test("the shared bounds follow the slower service", () => {
    // Anything without a provider in hand must not poll faster than the one
    // that tolerates it least.
    assert.strictEqual(MIN_USAGE_RETRY_MS, usageRetryBounds("claude").minMs);
    assert.strictEqual(MAX_USAGE_RETRY_MS, usageRetryBounds("claude").maxMs);
  });

  test("the range is wide enough to keep several windows apart", () => {
    // Windows opened together would otherwise line up and hit the endpoint at
    // the same instant, every time.
    for (const provider of ["codex", "claude"] as const) {
      const { minMs, maxMs } = usageRetryBounds(provider);
      assert.ok(maxMs - minMs >= 15_000, `${provider} needs room to spread out`);
    }
  });
  test("a refusal backs off further each time, not straight to the ceiling", () => {
    // Claude sends no Retry-After, so the wait is a guess. Starting at fifteen
    // minutes, as this used to, meant one transient refusal cost a quarter of an
    // hour of stale figures.
    const waits = [1, 2, 3, 4].map((n) => rateLimitBackoffMs(n));
    assert.deepStrictEqual(
      waits.map((ms) => ms / 60_000),
      [3, 6, 12, 15],
      "three, six, twelve, then fifteen minutes",
    );
    for (let i = 1; i < waits.length; i++) {
      assert.ok(waits[i] > waits[i - 1], "each wait must be longer than the last");
    }
  });

  test("the backoff stops climbing instead of running away", () => {
    for (const refusals of [4, 5, 20, 500]) {
      assert.strictEqual(
        rateLimitBackoffMs(refusals),
        MAX_RATE_LIMIT_BACKOFF_MS,
        `${refusals} refusals should sit at the ceiling, not beyond it`,
      );
    }
    // A nonsensical count must still produce the shortest sane wait, never zero.
    assert.strictEqual(rateLimitBackoffMs(0), 3 * 60_000);
    assert.strictEqual(rateLimitBackoffMs(-5), 3 * 60_000);
  });
});
