import * as assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REFRESH_LOCK_TTL_MS,
  refreshLockPath,
  withCredentialRefreshLock,
} from "../../provider/credentialRefreshLock.js";

/**
 * One refresh at a time, across processes.
 *
 * Anthropic's refresh tokens are single-use and rotate with no overlap window,
 * so a second window refreshing the same account does not merely duplicate
 * work — it spends a grant the first window is about to rely on, and one of
 * the two ends up signed out.
 */
suite("Credential refresh single-flight", () => {
  let dir: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "refresh-lock-"));
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the holder runs and the lock is released afterwards", async () => {
    const outcome = await withCredentialRefreshLock("acct", async () => "refreshed", { dir });

    assert.deepStrictEqual(outcome, { ran: true, value: "refreshed" });
    assert.ok(!existsSync(refreshLockPath("acct", dir)), "the lock must not outlive the refresh");
  });

  test("a second caller does not refresh while the first is in flight", async () => {
    let started = 0;
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const holder = withCredentialRefreshLock("acct", async () => {
      started++;
      await first;
      return "first";
    }, { dir });

    // Deliberately no wait: the point is that it declines rather than queues.
    const contender = await withCredentialRefreshLock("acct", async () => {
      started++;
      return "second";
    }, { dir, waitMs: 0 });

    assert.deepStrictEqual(contender, { ran: false });
    assert.strictEqual(started, 1, "the second caller must not spend a second grant");

    releaseFirst();
    assert.deepStrictEqual(await holder, { ran: true, value: "first" });
  });

  test("a different account is not blocked by the first", async () => {
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const holder = withCredentialRefreshLock("acct-a", async () => { await first; return "a"; }, { dir });

    const other = await withCredentialRefreshLock("acct-b", async () => "b", { dir, waitMs: 0 });

    assert.deepStrictEqual(other, { ran: true, value: "b" });
    releaseFirst();
    await holder;
  });

  test("a lock left behind by a dead process is reclaimed", async () => {
    // A crash between acquire and release leaves the file; without a TTL every
    // window on the machine would stop refreshing for good.
    const lockPath = refreshLockPath("acct", dir);
    writeFileSync(lockPath, "");
    const stale = new Date(Date.now() - (REFRESH_LOCK_TTL_MS + 60_000));
    utimesSync(lockPath, stale, stale);

    const outcome = await withCredentialRefreshLock("acct", async () => "refreshed", { dir, waitMs: 0 });

    assert.deepStrictEqual(outcome, { ran: true, value: "refreshed" });
  });

  test("a fresh lock is respected rather than reclaimed", async () => {
    writeFileSync(refreshLockPath("acct", dir), "");

    const outcome = await withCredentialRefreshLock("acct", async () => "refreshed", { dir, waitMs: 0 });

    assert.deepStrictEqual(outcome, { ran: false });
  });

  test("a failing refresh still releases the lock", async () => {
    await assert.rejects(
      withCredentialRefreshLock("acct", async () => { throw new Error("boom"); }, { dir }),
      /boom/,
    );

    assert.ok(!existsSync(refreshLockPath("acct", dir)));
  });

  test("the lock file does not spell out which account it guards", () => {
    const path = refreshLockPath("keychain:Claude Code-credentials", dir);

    assert.ok(!path.includes("Claude"), "a credential store name has no business in a world-readable path");
    assert.ok(path.startsWith(join(dir, "token-watch-refresh-")));
  });

  test("waiting callers give up at the deadline instead of hanging", async () => {
    writeFileSync(refreshLockPath("acct", dir), "");
    const startedAt = Date.now();

    const outcome = await withCredentialRefreshLock("acct", async () => "refreshed", {
      dir,
      waitMs: 120,
      pollMs: 20,
    });

    assert.deepStrictEqual(outcome, { ran: false });
    assert.ok(Date.now() - startedAt >= 100, "it should have waited for the holder first");
  });
});
