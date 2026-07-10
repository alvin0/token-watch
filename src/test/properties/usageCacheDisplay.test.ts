import * as assert from "node:assert";
import { formatUsageTime } from "../../webview/usageCacheDisplay.js";

suite("Usage cache display", () => {
  test("formats cache and retry timestamps without a countdown", () => {
    const timestamp = new Date(2026, 0, 1, 15, 7).getTime();
    assert.strictEqual(formatUsageTime("Cached at", timestamp), "Cached at 3:07 PM");
    assert.strictEqual(formatUsageTime("Retry at", timestamp), "Retry at 3:07 PM");
    assert.strictEqual(formatUsageTime("Retry at", undefined), undefined);
  });
});
