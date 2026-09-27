import * as assert from "node:assert";

import {
  DEFAULT_CARD_ORDER,
  LAYOUT_TABS,
  defaultTabLayout,
  resolveCardLayout,
  showsUsageCards,
} from "../../shared/cardLayout.js";

suite("Card layout", () => {
  test("nothing stored gives every tab its default order, all shown", () => {
    const layout = resolveCardLayout(undefined);
    for (const tab of LAYOUT_TABS) {
      assert.deepStrictEqual(layout[tab], defaultTabLayout(tab));
    }
  });

  test("keeps a stored order and hidden cards", () => {
    const layout = resolveCardLayout({
      today: [
        { id: "toolCalls", visible: true },
        { id: "periodCost", visible: false },
        ...DEFAULT_CARD_ORDER.today.filter((id) => id !== "toolCalls" && id !== "periodCost").map((id) => ({ id, visible: true })),
      ],
    });

    assert.deepStrictEqual(layout.today.slice(0, 2), [
      { id: "toolCalls", visible: true },
      { id: "periodCost", visible: false },
    ]);
    assert.strictEqual(layout.today.length, DEFAULT_CARD_ORDER.today.length);
  });

  test("each tab keeps its own layout", () => {
    const layout = resolveCardLayout({ week: [{ id: "topModels", visible: false }] });

    assert.deepStrictEqual(layout.today, defaultTabLayout("today"));
    assert.deepStrictEqual(layout.week.find((slot) => slot.id === "topModels"), { id: "topModels", visible: false });
  });

  test("drops unknown cards, cards that belong to another tab, and repeats", () => {
    const layout = resolveCardLayout({
      week: [
        { id: "somethingNew", visible: true },
        { id: "codexUsage", visible: true },
        { id: "topModels", visible: false },
        { id: "topModels", visible: true },
        "not a slot",
      ],
    });

    assert.deepStrictEqual(layout.week.map((slot) => slot.id).sort(), [...DEFAULT_CARD_ORDER.week].sort());
    assert.deepStrictEqual(layout.week.find((slot) => slot.id === "topModels"), { id: "topModels", visible: false });
  });

  test("a card missing from the stored layout comes back at its default place, shown", () => {
    // As if `toolCalls` were added in a later version than the one that saved this.
    const layout = resolveCardLayout({
      today: DEFAULT_CARD_ORDER.today.filter((id) => id !== "toolCalls").reverse().map((id) => ({ id, visible: false })),
    });

    const ids = layout.today.map((slot) => slot.id);
    // By default it follows claudeUsage, so that is where it returns.
    assert.strictEqual(ids.indexOf("toolCalls"), ids.indexOf("claudeUsage") + 1);
    assert.deepStrictEqual(layout.today.find((slot) => slot.id === "toolCalls"), { id: "toolCalls", visible: true });
  });

  test("a malformed setting falls back to the defaults", () => {
    for (const stored of [null, 42, "today", [], { today: "periodCost" }]) {
      assert.deepStrictEqual(resolveCardLayout(stored).today, defaultTabLayout("today"), JSON.stringify(stored));
    }
  });

  test("usage cards count as shown while either one is visible on Today", () => {
    const hideBoth = resolveCardLayout({
      today: [{ id: "codexUsage", visible: false }, { id: "claudeUsage", visible: false }],
    });
    const hideOne = resolveCardLayout({ today: [{ id: "codexUsage", visible: false }] });

    assert.strictEqual(showsUsageCards(resolveCardLayout(undefined)), true);
    assert.strictEqual(showsUsageCards(hideOne), true);
    assert.strictEqual(showsUsageCards(hideBoth), false);
  });
});
