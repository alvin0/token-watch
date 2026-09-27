import * as assert from "node:assert";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchOwnerSnapshot } from "../../worker/ownerSnapshotWatch.js";

/**
 * A follower window must pick up each snapshot the owner flushes, not only the
 * ones that happen to follow a log change it saw itself.
 */
suite("Owner snapshot watch", () => {
  let dir: string;
  let dbPath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-snapshot-"));
    dbPath = join(dir, "usage.sqlite");
    writeFileSync(dbPath, "first snapshot");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error("condition not met in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("reports a snapshot flushed by rename, the way the store writes it", async () => {
    let changes = 0;
    const stop = watchOwnerSnapshot(dbPath, () => { changes += 1; }, 5);
    try {
      const temp = join(dir, "usage.sqlite.tmp");
      writeFileSync(temp, "second snapshot, longer");
      renameSync(temp, dbPath);

      await waitFor(() => changes > 0);
      assert.strictEqual(changes, 1);
    } finally {
      stop();
    }
  });

  test("stays quiet while the file is untouched", async () => {
    let changes = 0;
    const stop = watchOwnerSnapshot(dbPath, () => { changes += 1; }, 5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(changes, 0);
    } finally {
      stop();
    }
  });

  test("stops reporting once unsubscribed", async () => {
    let changes = 0;
    const stop = watchOwnerSnapshot(dbPath, () => { changes += 1; }, 5);
    stop();

    writeFileSync(dbPath, "a later snapshot");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(changes, 0);
  });
});
