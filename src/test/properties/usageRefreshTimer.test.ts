import * as assert from "node:assert";
import { UsageRefreshTimer } from "../../host/UsageRefreshTimer.js";

suite("Usage refresh timer", () => {
  test("schedules at retry time and replaces the previous timeout", () => {
    let scheduled: { callback: () => void; delay: number } | undefined;
    const cleared: unknown[] = [];
    let refreshes = 0;
    const runtime = {
      now: () => 1_000,
      setTimeout: (callback: () => void, delay: number) => {
        scheduled = { callback, delay };
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        cleared.push(handle);
      },
    };
    const timer = new UsageRefreshTimer(() => { refreshes += 1; }, runtime);

    timer.schedule(2_500);
    assert.strictEqual(scheduled?.delay, 1_500);

    timer.schedule(3_000);
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], 0);
    assert.strictEqual(scheduled?.delay, 2_000);

    scheduled?.callback();
    assert.strictEqual(refreshes, 1);
  });

  test("does not schedule without a finite retry time", () => {
    let scheduled = false;
    const timer = new UsageRefreshTimer(() => undefined, {
      now: () => 1_000,
      setTimeout: () => {
        scheduled = true;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    timer.schedule();
    timer.schedule(Number.NaN);

    assert.strictEqual(scheduled, false);
  });
});
