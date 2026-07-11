import * as assert from "assert";
import {
  MAX_USAGE_RETRY_MS,
  MIN_USAGE_RETRY_MS,
  randomUsageRetryMs,
} from "../../shared/usageRetry.js";

suite("Usage retry interval", () => {
  test("randomizes inclusively between 1m15s and 2m15s", () => {
    assert.strictEqual(randomUsageRetryMs(() => 0), MIN_USAGE_RETRY_MS);
    assert.strictEqual(randomUsageRetryMs(() => 0.5), 105_000);
    assert.strictEqual(randomUsageRetryMs(() => 0.999999), MAX_USAGE_RETRY_MS);
  });
});
