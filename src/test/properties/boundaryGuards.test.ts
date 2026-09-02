import * as assert from "node:assert";

import { isValidHostMessage, sanitizePersistedState } from "../../webview/messageGuards.js";
import { localTimezoneIdentity, timezoneIdentityChanged } from "../../shared/time.js";

const VALID_WARNINGS = { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0, lostUsageLineCount: 0 };

suite("Host message validation", () => {
  test("accepts the messages the host actually sends", () => {
    const messages: unknown[] = [
      { type: "dataChanged" },
      {
        type: "queryResult",
        id: "q-1",
        result: {
          view: "dashboard", series: [], variants: [], sessions: [], contextSessions: [],
          tools: [], toolCallsByDay: [], hourlySeries: [],
        },
      },
      { type: "queryResult", id: "q-2", result: { view: "series", series: [] } },
      { type: "queryError", id: "q-1", message: "boom" },
      { type: "ingestProgress", processed: 1, total: 2, partial: true },
      { type: "status", freshness: {}, warnings: VALID_WARNINGS },
      { type: "costAlertSettings", rules: [] },
      { type: "pricingSettings", table: {} },
      { type: "language", language: "vi" },
    ];
    for (const message of messages) {
      assert.ok(isValidHostMessage(message), `should accept ${JSON.stringify(message)}`);
    }
  });

  test("rejects payloads that would throw inside a render", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      "status",
      42,
      [],
      { type: 7 },
      { type: "status" },
      { type: "status", freshness: {} },
      { type: "status", freshness: null, warnings: VALID_WARNINGS },
      { type: "status", freshness: {}, warnings: { unmappedModels: "not an array" } },
      { type: "queryResult", id: "q-1" },
      { type: "queryResult", id: "q-1", result: null },
      { type: "queryResult", result: { view: "dashboard" } },
      // A dashboard missing the arrays its cards iterate: accepting this let a
      // card call .filter() on undefined and blank the panel mid-render.
      { type: "queryResult", id: "q-1", result: { view: "dashboard", series: [] } },
      {
        type: "queryResult",
        id: "q-1",
        result: {
          view: "dashboard", series: [], variants: [], sessions: [],
          tools: [], toolCallsByDay: [], hourlySeries: [],
        },
      },
      { type: "queryResult", id: "q-1", result: { view: "dashboard", series: "not an array" } },
      { type: "queryResult", id: "q-1", result: { view: "nonsense", series: [] } },
      { type: "queryResult", id: "q-1", result: { view: "series" } },
      { type: "ingestProgress", processed: "one", total: 2, partial: true },
      { type: "ingestProgress", processed: 1, total: Number.NaN, partial: true },
      { type: "language", language: "klingon" },
      { type: "pricingSettings", table: "nope" },
      { type: "costAlertSettings", rules: {} },
    ];
    for (const message of malformed) {
      assert.strictEqual(
        isValidHostMessage(message),
        false,
        `should reject ${JSON.stringify(message)}`,
      );
    }
  });

  test("an unknown type from a newer host is passed through, not treated as an error", () => {
    assert.ok(isValidHostMessage({ type: "somethingNewer", payload: 1 }));
  });
});

suite("Persisted state sanitizing", () => {
  test("keeps values this version understands", () => {
    assert.deepStrictEqual(
      sanitizePersistedState({ granularity: "week", sources: ["codex"], language: "ja" }),
      { granularity: "week", sources: ["codex"], language: "ja" },
    );
  });

  test("drops a granularity a previous version wrote", () => {
    assert.deepStrictEqual(sanitizePersistedState({ granularity: "fortnight" }), {});
  });

  test("drops unknown sources and languages", () => {
    assert.deepStrictEqual(sanitizePersistedState({ sources: ["codex", "gemini"] }), { sources: ["codex"] });
    assert.deepStrictEqual(sanitizePersistedState({ sources: ["gemini"] }), {});
    assert.deepStrictEqual(sanitizePersistedState({ language: "klingon" }), {});
  });

  test("a non-object survives as empty state rather than throwing", () => {
    for (const value of [null, undefined, 7, "state", []]) {
      assert.deepStrictEqual(sanitizePersistedState(value), {});
    }
  });
});

suite("Timezone identity", () => {
  test("identity carries the zone and the offset", () => {
    const identity = localTimezoneIdentity();
    assert.match(identity, /^.+@-?\d+$/, `Unexpected identity shape: ${identity}`);
  });

  test("no stored identity is not a change", () => {
    assert.strictEqual(timezoneIdentityChanged(undefined, localTimezoneIdentity()), false);
  });

  test("the same zone at a different offset is a DST shift, not a move", () => {
    assert.strictEqual(
      timezoneIdentityChanged("Europe/Berlin@60", "Europe/Berlin@120"),
      false,
      "Summer time must not trigger a full re-ingest",
    );
  });

  test("a different zone is a move, whatever the offset", () => {
    assert.strictEqual(timezoneIdentityChanged("Europe/Berlin@60", "Asia/Bangkok@420"), true);
    assert.strictEqual(
      timezoneIdentityChanged("Europe/London@0", "Africa/Abidjan@0"),
      true,
      "Same offset, different zone: day boundaries still differ across the year",
    );
  });

  test("a fixed-offset environment falls back to the offset", () => {
    // Minimal-ICU builds report no zone name, so the zone comparison alone
    // would call every move "unknown -> unknown" and never re-read the logs.
    assert.strictEqual(
      timezoneIdentityChanged("unknown@0", "unknown@420"),
      true,
      "With no zone name the offset is the only evidence of a move",
    );
    assert.strictEqual(timezoneIdentityChanged("unknown@420", "unknown@420"), false);
  });

  test("gaining or losing a zone name counts as a move", () => {
    assert.strictEqual(timezoneIdentityChanged("unknown@420", "Asia/Bangkok@420"), false,
      "Same offset, one side simply learned its name");
    assert.strictEqual(timezoneIdentityChanged("unknown@0", "Asia/Bangkok@420"), true);
  });

  test("a zone name containing @ is still split correctly", () => {
    assert.strictEqual(timezoneIdentityChanged("Weird@Zone@60", "Weird@Zone@120"), false);
    assert.strictEqual(timezoneIdentityChanged("Weird@Zone@60", "Other@Zone@60"), true);
  });
});
