import * as assert from "node:assert";

import type { AnalyticsResult, HostMessage, WebviewRequest } from "../../shared/protocol.js";

/**
 * The store reaches for `acquireVsCodeApi()` and `window` when the module is
 * first evaluated, so both have to exist before the import.
 */
const posted: WebviewRequest[] = [];
let hostListener: ((event: { data: HostMessage }) => void) | undefined;

function installWebviewGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g["acquireVsCodeApi"] = () => ({
    postMessage: (msg: WebviewRequest) => { posted.push(msg); },
    getState: () => undefined,
    setState: () => { /* no persistence in tests */ },
  });
  g["window"] = {
    addEventListener: (_type: string, fn: (event: { data: HostMessage }) => void) => {
      hostListener = fn;
    },
  };
}

/** Just enough of a dashboard result to be cached and read back. */
function dashboardResult(marker: string): AnalyticsResult {
  return {
    view: "dashboard",
    series: [],
    hourly: [],
    models: [],
    tools: [],
    sessions: [],
    totals: { totalTokens: 0, costUsd: 0, turns: 0 },
    marker,
  } as unknown as AnalyticsResult;
}

function queriesPosted(): WebviewRequest[] {
  return posted.filter((m) => m.type === "query");
}

suite("Switching tabs reuses what was already fetched", () => {
  let useStore: typeof import("../../webview/store.js")["useStore"];

  suiteSetup(async () => {
    installWebviewGlobals();
    ({ useStore } = await import("../../webview/store.js"));
  });

  setup(() => {
    posted.length = 0;
  });

  /** Drive one full round trip and hand back the result that was cached. */
  function completeQuery(marker: string): { key: string; result: AnalyticsResult } {
    const query = queriesPosted().at(-1);
    assert.ok(query && query.type === "query", `expected a query to have been posted for ${marker}`);
    const key = useStore.getState().activeKey;
    const result = dashboardResult(marker);
    useStore.getState().applyResult(query.id, result);
    return { key, result };
  }

  test("a revisited tab costs no query at all", () => {
    const store = useStore.getState();

    store.setFilter({ granularity: "week" });
    assert.strictEqual(queriesPosted().length, 1, "the first visit has to ask the worker");
    const week = completeQuery("week");

    posted.length = 0;
    store.setFilter({ granularity: "month" });
    assert.strictEqual(queriesPosted().length, 1, "a tab never seen before has to ask");
    completeQuery("month");

    // The whole point: coming back is a lookup, not a round trip. This used to
    // clear every cached result on each filter change, so returning to a tab
    // shown seconds earlier rebuilt it against the full database.
    posted.length = 0;
    store.setFilter({ granularity: "week" });
    assert.strictEqual(queriesPosted().length, 0, "returning to a loaded tab must not re-query");
    assert.strictEqual(useStore.getState().activeKey, week.key);
    assert.strictEqual(useStore.getState().results[week.key], week.result);
    assert.strictEqual(useStore.getState().queryPending, false, "nothing is pending, so nothing may blank");
  });

  test("source toggles are keyed too, not just periods", () => {
    const store = useStore.getState();

    store.setFilter({ granularity: "day", sources: ["codex", "claude"] });
    const both = completeQuery("day-both");
    posted.length = 0;

    store.setFilter({ sources: ["codex"] });
    assert.strictEqual(queriesPosted().length, 1, "a different source set is a different question");
    completeQuery("day-codex");
    posted.length = 0;

    store.setFilter({ sources: ["codex", "claude"] });
    assert.strictEqual(queriesPosted().length, 0, "switching back is cached");
    assert.strictEqual(useStore.getState().results[both.key], both.result);
  });

  test("new data invalidates the cache without blanking the panel", () => {
    const store = useStore.getState();

    store.setFilter({ granularity: "year" });
    const year = completeQuery("year-v1");
    posted.length = 0;

    store.setFilter({ granularity: "today" });
    completeQuery("today-v1");
    posted.length = 0;

    assert.ok(hostListener, "the store must have registered a host listener");
    hostListener({ data: { type: "dataChanged" } as HostMessage });
    // dataChanged refreshes whatever is on screen; settle it so the next
    // request is not merely queued behind this one.
    completeQuery("today-v2");
    posted.length = 0;

    store.setFilter({ granularity: "year" });
    assert.strictEqual(queriesPosted().length, 1, "a stale result has to be rebuilt");
    // ...but the reader keeps seeing the old numbers while that happens, which
    // is the difference between a refresh and a reload.
    assert.strictEqual(
      useStore.getState().results[year.key],
      year.result,
      "the stale result must stay on screen during the refresh",
    );
    assert.strictEqual(
      useStore.getState().queryPending,
      false,
      "pending is for an empty panel only; there is something to show here",
    );
    // Settle it, so the next test does not find a request still in flight and
    // silently get queued behind it.
    completeQuery("year-v2");
  });
  test("the other tabs are fetched behind the one on screen", async () => {
    // Runs last, and against a source set of its own: the prefetch fills the
    // cache for every period, which would decide the earlier tests for them.
    //
    // Switching to a tab for the first time used to wait on a query. Each costs
    // the worker a few tens of milliseconds, so they are pulled in once the
    // visible tab is drawn rather than in front of the reader.
    useStore.getState().setFilter({ granularity: "today", sources: ["claude"] });
    completeQuery("today");

    // The prefetch waits for an idle callback or a timeout; let it out.
    posted.length = 0;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    const asked = queriesPosted();
    assert.ok(asked.length > 0, "the other periods should have been asked for");

    for (const msg of asked) {
      if (msg.type !== "query") { continue; }
      useStore.getState().applyResult(msg.id, dashboardResult("prefetched"));
    }

    assert.strictEqual(
      useStore.getState().queryPending,
      false,
      "a prefetch must never put the panel into a loading state",
    );
    assert.strictEqual(useStore.getState().granularity, "today", "nor move the reader");

    posted.length = 0;
    useStore.getState().setFilter({ granularity: "month" });
    assert.strictEqual(
      queriesPosted().length,
      0,
      "the first visit to a prefetched tab must cost no query either",
    );
    assert.ok(
      useStore.getState().results[useStore.getState().activeKey],
      "and it must have something to draw",
    );
  });
  test("a first scan shows numbers as it finds them, not at the end", async () => {
    // A fresh install used to watch a progress bar for the whole pass and then
    // get everything at once. Nothing asked again while the scan ran.
    useStore.getState().setFilter({ granularity: "day", sources: ["codex"] });
    const first = queriesPosted().at(-1);
    assert.ok(first && first.type === "query");
    // Answered, but the scan has not found anything for this period yet.
    useStore.getState().applyResult(first.id, dashboardResult("empty"));

    assert.ok(hostListener);
    posted.length = 0;
    hostListener({ data: { type: "ingestProgress", processed: 20, total: 78, partial: true } });
    assert.strictEqual(
      queriesPosted().length,
      1,
      "with nothing to draw yet, progress should prompt another look",
    );

    // Throttled: a burst of progress ticks must not become a burst of queries.
    posted.length = 0;
    for (let i = 21; i < 30; i++) {
      hostListener({ data: { type: "ingestProgress", processed: i, total: 78, partial: true } });
    }
    assert.strictEqual(queriesPosted().length, 0, "further ticks within the window are ignored");
  });
});
