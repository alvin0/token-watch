import * as assert from "node:assert";
import * as vscode from "vscode";
import { LIMIT_RESET_REMINDERS_STORAGE_KEY, LimitResetReminder } from "../../host/LimitResetReminder.js";
import { withLimitResetDetails } from "../../host/limitResets.js";
import { LIMIT_RESET_EXPIRY_WARNING_MS } from "../../shared/codexUsage.js";

suite("Usage limit reset reminder", () => {
  const now = Date.UTC(2026, 8, 1, 12);
  const inDays = (days: number) => now + days * 24 * 60 * 60 * 1000;

  function build(state = new MemoryMemento()) {
    const messages: string[] = [];
    const reminder = new LimitResetReminder(
      state as unknown as vscode.Memento,
      (message) => { messages.push(message); return Promise.resolve(undefined); },
      () => "en",
      () => now,
    );
    return { reminder, messages, state };
  }

  test("warns once per reset that expires within seven days", async () => {
    const { reminder, messages, state } = build();
    const limitResets = {
      availableCount: 1,
      resets: [{ id: "reset-1", expiresAtUtc: inDays(3) }],
    };

    await reminder.evaluate(limitResets);
    await reminder.evaluate(limitResets);

    assert.strictEqual(messages.length, 1);
    assert.ok(messages[0].includes("Token Watch"));
    assert.ok(/expires/i.test(messages[0]));
    assert.deepStrictEqual(state.get(LIMIT_RESET_REMINDERS_STORAGE_KEY), ["reset-1"]);
  });

  test("stays quiet for resets that are further out, already expired, or undated", async () => {
    const { reminder, messages } = build();

    await reminder.evaluate({
      availableCount: 3,
      resets: [
        { id: "far", expiresAtUtc: now + LIMIT_RESET_EXPIRY_WARNING_MS + 1 },
        { id: "expired", expiresAtUtc: inDays(-1) },
        { id: "undated" },
      ],
    });

    assert.deepStrictEqual(messages, []);
  });

  test("warns a reset that later crosses into the seven-day window", async () => {
    const { reminder, messages } = build();

    await reminder.evaluate({ availableCount: 1, resets: [{ id: "reset-1", expiresAtUtc: inDays(30) }] });
    assert.deepStrictEqual(messages, []);

    await reminder.evaluate({ availableCount: 1, resets: [{ id: "reset-1", expiresAtUtc: inDays(2) }] });
    assert.strictEqual(messages.length, 1);
  });

  test("does nothing until the reset list has actually been loaded", async () => {
    const { reminder, messages, state } = build();

    await reminder.evaluate(undefined);
    await reminder.evaluate({ availableCount: 1 });

    assert.deepStrictEqual(messages, []);
    assert.strictEqual(state.get(LIMIT_RESET_REMINDERS_STORAGE_KEY), undefined);
  });

  test("forgets resets the account no longer has", async () => {
    const state = new MemoryMemento({ [LIMIT_RESET_REMINDERS_STORAGE_KEY]: ["gone", "reset-1"] });
    const { reminder, messages } = build(state);

    await reminder.evaluate({ availableCount: 1, resets: [{ id: "reset-1", expiresAtUtc: inDays(3) }] });

    assert.deepStrictEqual(messages, []);
    assert.deepStrictEqual(state.get(LIMIT_RESET_REMINDERS_STORAGE_KEY), ["reset-1"]);
  });
});

suite("Usage limit reset details", () => {
  test("attaches the fetched resets to the counts from the usage payload", async () => {
    const merged = await withLimitResetDetails(
      async () => ({
        credits: [{ id: "reset-1", status: "available", title: "Full reset", expires_at: "2026-09-20T23:58:18Z" }],
      }),
      { availableCount: 1 },
    );

    assert.deepStrictEqual(merged, {
      availableCount: 1,
      resets: [{ id: "reset-1", title: "Full reset", expiresAtUtc: Date.parse("2026-09-20T23:58:18Z") }],
    });
  });

  test("skips the request when the account has no resets left", async () => {
    let called = false;
    const counts = { availableCount: 0 };

    const merged = await withLimitResetDetails(
      async () => { called = true; return {}; },
      counts,
    );

    assert.strictEqual(called, false);
    assert.strictEqual(merged, counts);
    assert.strictEqual(await withLimitResetDetails(async () => ({}), undefined), undefined);
  });

  test("keeps the counts when the reset request fails", async () => {
    const counts = { availableCount: 1 };

    const merged = await withLimitResetDetails(
      () => Promise.reject(new Error("boom")),
      counts,
    );

    assert.deepStrictEqual(merged, counts);
  });
});

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }
}
