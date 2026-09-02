import * as assert from "node:assert";

import { soonestExpiry } from "../../webview/limitResets.js";
import type { UsageLimitResetsInfo } from "../../shared/protocol.js";

/**
 * The reset line shows a count and one date.
 *
 * The itemised list — which reset, of what kind, expiring when — is reference
 * material, and sitting it in the card pushed the numbers people open the card
 * for further down the more of it there was. It moved behind "show more"; what
 * stays is how many are left and the deadline, which is the soonest expiry.
 */
suite("The reset line shows the deadline", () => {
  const info = (expiries: Array<number | undefined>): UsageLimitResetsInfo => ({
    availableCount: expiries.length,
    resets: expiries.map((expiresAtUtc, index) => ({
      id: `reset-${index}`,
      title: `Reset ${index}`,
      ...(expiresAtUtc === undefined ? {} : { expiresAtUtc }),
    })),
  }) as UsageLimitResetsInfo;

  test("it is the soonest expiry, not whichever came first in the list", () => {
    // The order the provider sends them in is not the order they run out.
    const soonest = soonestExpiry(info([5_000, 1_000, 3_000]));
    assert.strictEqual(soonest, 1_000, "the deadline is the one that expires first");
  });

  test("resets with no expiry are passed over, not treated as immediate", () => {
    assert.strictEqual(soonestExpiry(info([undefined, 4_000, undefined])), 4_000);
    assert.strictEqual(
      soonestExpiry(info([undefined, undefined])),
      undefined,
      "with no dated reset there is no deadline to show",
    );
  });

  test("no resets means no date", () => {
    assert.strictEqual(soonestExpiry(info([])), undefined);
    assert.strictEqual(
      soonestExpiry({ availableCount: 2 } as UsageLimitResetsInfo),
      undefined,
      "a count without the list behind it still must not invent a date",
    );
  });

  test("a single reset is its own deadline", () => {
    assert.strictEqual(soonestExpiry(info([9_999])), 9_999);
  });
});
