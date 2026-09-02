import * as assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WriterLease } from "../../worker/writerLease.js";

suite("Writer lease", () => {
  let dir: string;
  let leasePath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-lease-"));
    leasePath = join(dir, "db.owner");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lease(pid: number, now: () => number, alive: (candidate: number) => boolean = () => true) {
    return new WriterLease({ leasePath, now, pid, isProcessAlive: alive, ttlMs: 1000 });
  }

  test("the first worker becomes the writer and the second does not", () => {
    const clock = 0;
    const first = lease(11, () => clock);
    const second = lease(22, () => clock);

    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire(), false, "A live lease must not be taken");
    assert.strictEqual(first.isOwner(), true);
    assert.strictEqual(second.isOwner(), false);
  });

  test("the owner keeps the lease across renewals", () => {
    let clock = 0;
    const owner = lease(11, () => clock);
    assert.strictEqual(owner.tryAcquire(), true);
    clock += 500;
    assert.strictEqual(owner.tryAcquire(), true, "Renewal must not lose the lease");
    clock += 500;
    assert.strictEqual(owner.tryAcquire(), true);
  });

  test("an expired lease is taken over", () => {
    let clock = 0;
    const first = lease(11, () => clock);
    const second = lease(22, () => clock);
    assert.strictEqual(first.tryAcquire(), true);

    clock += 1001; // past the TTL with no renewal
    assert.strictEqual(second.tryAcquire(), true, "A stale lease must be reclaimable");
  });

  test("a lease held by a dead process is taken over immediately", () => {
    const clock = () => 0;
    const first = lease(11, clock);
    assert.strictEqual(first.tryAcquire(), true);

    const second = lease(22, clock, (pid) => pid !== 11);
    assert.strictEqual(second.tryAcquire(), true, "A dead holder must not block ingestion");
  });

  test("an explicit rescan steals the lease", () => {
    const clock = () => 0;
    const first = lease(11, clock);
    const second = lease(22, clock);
    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire(), false);
    assert.strictEqual(second.tryAcquire({ steal: true }), true, "A user rescan makes this window the writer");
  });

  test("release hands the lease over without waiting for the TTL", () => {
    const clock = () => 0;
    const first = lease(11, clock);
    const second = lease(22, clock);
    assert.strictEqual(first.tryAcquire(), true);
    first.release();
    assert.strictEqual(existsSync(leasePath), false, "Releasing removes the lease file");
    assert.strictEqual(second.tryAcquire(), true);
  });

  test("a corrupt lease file does not wedge the writer election", () => {
    const clock = () => 0;
    const owner = lease(11, clock);
    assert.strictEqual(owner.tryAcquire(), true);
    // Simulate a torn write from an interrupted process.
    writeFileSync(leasePath, "{not json");
    const other = lease(22, clock);
    assert.strictEqual(other.tryAcquire(), true, "An unreadable lease is treated as free");
  });
});


suite("Writer lease single-owner invariant", () => {
  let dir: string;
  let leasePath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-lease-owner-"));
    leasePath = join(dir, "db.owner");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lease(pid: number, now: () => number, alive: (candidate: number) => boolean = () => true) {
    return new WriterLease({
      leasePath,
      now,
      pid,
      isProcessAlive: alive,
      ttlMs: 1000,
      renewIntervalMs: 0,
    });
  }

  test("a steal takes ownership away from the previous owner", () => {
    const clock = 0;
    const first = lease(11, () => clock);
    const second = lease(22, () => clock);

    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire({ steal: true }), true);

    // The old owner must notice, rather than trusting a boolean it set earlier.
    assert.strictEqual(first.isOwner(), false, "A stolen lease must not still report ownership");
    assert.strictEqual(second.isOwner(), true);
  });

  test("a renewal after a steal does not clobber the new owner", () => {
    let clock = 0;
    const first = lease(11, () => clock);
    const second = lease(22, () => clock);

    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire({ steal: true }), true);

    clock += 10;
    // The displaced worker's next heartbeat must fail, not overwrite the file.
    assert.strictEqual(first.tryAcquire(), false, "A renewal must verify the lease is still ours");
    assert.strictEqual(second.isOwner(), true, "The real owner keeps the lease");
    assert.strictEqual(first.isOwner(), false);
  });

  test("an expired lease leaves exactly one owner even with racing takeovers", () => {
    let clock = 0;
    const original = lease(11, () => clock);
    assert.strictEqual(original.tryAcquire(), true);

    clock += 5000; // well past the TTL
    const contenders = [lease(21, () => clock), lease(22, () => clock), lease(23, () => clock)];
    const winners = contenders.filter((candidate) => candidate.tryAcquire());

    assert.strictEqual(winners.length, 1, "Exactly one worker may reclaim a stale lease");
    assert.strictEqual(original.isOwner(), false, "The expired holder must stand down");
  });

  test("a corrupt lease file still yields exactly one owner", () => {
    const clock = () => 0;
    // A torn write from an interrupted process: present but unreadable.
    writeFileSync(leasePath, "{not json");

    const contenders = [lease(31, clock), lease(32, clock), lease(33, clock)];
    const winners = contenders.filter((candidate) => candidate.tryAcquire());

    assert.strictEqual(winners.length, 1, "An unreadable lease must not let several workers claim it");
    assert.strictEqual(winners[0].isOwner(), true);
  });

  test("an owner that expires without renewing stops reporting ownership", () => {
    let clock = 0;
    const owner = lease(11, () => clock);
    assert.strictEqual(owner.tryAcquire(), true);
    assert.strictEqual(owner.isOwner(), true);

    clock += 5000; // TTL elapsed with no renewal
    assert.strictEqual(owner.isOwner(), false, "An expired lease is not ownership");
  });

  test("releasing a lease that is no longer ours leaves the new owner alone", () => {
    let clock = 0;
    const first = lease(11, () => clock);
    const second = lease(22, () => clock);
    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire({ steal: true }), true);

    clock += 1;
    first.release();
    assert.strictEqual(second.isOwner(), true, "Release must not delete another worker's lease");
  });

  test("renewals are throttled but still keep the lease alive", () => {
    let clock = 0;
    const owner = new WriterLease({
      leasePath,
      now: () => clock,
      pid: 11,
      isProcessAlive: () => true,
      ttlMs: 1000,
      renewIntervalMs: 100,
    });
    assert.strictEqual(owner.tryAcquire(), true);
    const afterFirst = readFileSync(leasePath, "utf8");

    clock += 10;
    assert.strictEqual(owner.tryAcquire(), true);
    assert.strictEqual(readFileSync(leasePath, "utf8"), afterFirst, "A throttled renewal must not rewrite the file");

    clock += 200;
    assert.strictEqual(owner.tryAcquire(), true);
    assert.notStrictEqual(readFileSync(leasePath, "utf8"), afterFirst, "Past the interval it renews for real");
    assert.strictEqual(owner.isOwner(), true);
  });
});


suite("Writer lease fencing", () => {
  let dir: string;
  let leasePath: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-fence-"));
    leasePath = join(dir, "db.owner");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lease(pid: number, now: () => number = () => Date.now()) {
    return new WriterLease({ leasePath, now, pid, isProcessAlive: () => true, ttlMs: 100_000, renewIntervalMs: 0 });
  }

  test("a displaced owner reports the loss immediately, with no grace period", () => {
    const first = lease(11);
    const second = lease(22);
    assert.strictEqual(first.tryAcquire(), true);
    assert.strictEqual(second.tryAcquire({ steal: true }), true);

    // No cache: the very next question must get the truth, because this is the
    // answer the store's write fence acts on.
    assert.strictEqual(first.isOwner(), false, "A stolen lease must never still read as owned");
    assert.strictEqual(second.isOwner(), true);
  });

  test("isOwner reflects the file even when nothing called tryAcquire", () => {
    const owner = lease(11);
    assert.strictEqual(owner.tryAcquire(), true);
    assert.strictEqual(owner.isOwner(), true);

    // Another process replaces the record directly.
    writeFileSync(leasePath, JSON.stringify({ pid: 99, token: "someone-else", renewedAtMs: Date.now() }));
    assert.strictEqual(owner.isOwner(), false);
  });

  test("a lease transition is never observed half-written", () => {
    const owner = lease(11);
    owner.tryAcquire();
    // The record is replaced by rename, so a reader sees the old or the new
    // one, never a truncated file that would look unowned to everybody.
    const raw = readFileSync(leasePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  test("only one of several racing workers ends up owning a free lease", () => {
    const contenders = [lease(31), lease(32), lease(33), lease(34)];
    const acquired = contenders.filter((candidate) => candidate.tryAcquire());
    assert.strictEqual(acquired.length, 1, "Exactly one worker may take a free lease");
    assert.deepStrictEqual(
      contenders.map((candidate) => candidate.isOwner()),
      contenders.map((candidate) => candidate === acquired[0]),
      "And every other worker must agree who it is",
    );
  });

  test("a transition lock left behind by a dead worker is reclaimed", () => {
    // Simulate a worker that died between taking the lock and releasing it.
    writeFileSync(`${leasePath}.lock`, "");
    const stale = Date.now() - 60_000;
    const owner = new WriterLease({
      leasePath, pid: 11, isProcessAlive: () => true,
      now: () => Date.now() + 60_000, ttlMs: 100_000, renewIntervalMs: 0,
    });
    assert.strictEqual(owner.tryAcquire(), true, "A stale transition lock must not wedge the election");
    void stale;
  });

  test("release only removes a lease this worker still holds", () => {
    const first = lease(11);
    const second = lease(22);
    first.tryAcquire();
    second.tryAcquire({ steal: true });
    first.release();
    assert.strictEqual(second.isOwner(), true, "Release must not delete the new owner's lease");
  });
});
