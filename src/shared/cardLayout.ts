/**
 * Which dashboard cards each period tab shows, and in what order.
 *
 * Each tab keeps its own layout: the tabs do not show the same cards (only
 * Today has the provider usage cards, only the longer periods have recent
 * periods), and one shared order would move cards around in tabs the person
 * was not looking at. The attention card is not listed: it always leads.
 *
 * Stored in the `tokenWatch.layout.cards` setting, so a change in one window
 * reaches every other one, and it rides Settings Sync to other machines.
 */

export const LAYOUT_TABS = ["today", "day", "week", "month", "year"] as const;
export type LayoutTab = (typeof LAYOUT_TABS)[number];

export type CardId =
  | "periodCost"
  | "tokenUsage"
  | "topModels"
  | "codexUsage"
  | "claudeUsage"
  | "toolCalls"
  | "usageTrend"
  | "insights"
  | "trendChart"
  | "dayTrend"
  | "recentPeriods";

export interface CardSlot {
  id: CardId;
  visible: boolean;
}

export type CardLayout = Record<LayoutTab, CardSlot[]>;

/** Every card a tab can show, in the order the dashboard has always used. */
export const DEFAULT_CARD_ORDER: Record<LayoutTab, readonly CardId[]> = {
  today: ["periodCost", "tokenUsage", "topModels", "codexUsage", "claudeUsage", "toolCalls", "usageTrend", "insights"],
  day: ["periodCost", "tokenUsage", "topModels", "toolCalls", "trendChart", "dayTrend", "recentPeriods"],
  week: ["periodCost", "tokenUsage", "topModels", "toolCalls", "trendChart", "recentPeriods"],
  month: ["periodCost", "tokenUsage", "topModels", "toolCalls", "trendChart", "recentPeriods"],
  year: ["periodCost", "tokenUsage", "topModels", "toolCalls", "trendChart", "recentPeriods"],
};

export function isLayoutTab(value: unknown): value is LayoutTab {
  return typeof value === "string" && (LAYOUT_TABS as readonly string[]).includes(value);
}

export function defaultTabLayout(tab: LayoutTab): CardSlot[] {
  return DEFAULT_CARD_ORDER[tab].map((id) => ({ id, visible: true }));
}

/**
 * Turn whatever is stored — hand-edited, from an older version, or nothing —
 * into a complete layout.
 *
 * Unknown and repeated cards are dropped. A card the stored layout does not
 * mention (one added in a later version) is put back where it sits by default
 * and shown, so an update never hides a new card from someone who customised
 * their layout before it existed.
 */
export function resolveCardLayout(stored: unknown): CardLayout {
  const record = isRecord(stored) ? stored : {};
  const layout = {} as CardLayout;
  for (const tab of LAYOUT_TABS) {
    layout[tab] = resolveTab(tab, record[tab]);
  }
  return layout;
}

/** Whether the Today tab shows either provider's usage card. */
export function showsUsageCards(layout: CardLayout): boolean {
  return layout.today.some((slot) => slot.visible && (slot.id === "codexUsage" || slot.id === "claudeUsage"));
}

function resolveTab(tab: LayoutTab, stored: unknown): CardSlot[] {
  const allowed = DEFAULT_CARD_ORDER[tab];
  const slots: CardSlot[] = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (!isRecord(entry) || !allowed.includes(entry.id as CardId)) { continue; }
    const id = entry.id as CardId;
    if (slots.some((slot) => slot.id === id)) { continue; }
    slots.push({ id, visible: entry.visible !== false });
  }

  allowed.forEach((id, defaultIndex) => {
    if (slots.some((slot) => slot.id === id)) { return; }
    // After the nearest card that precedes it by default, or first if none does.
    let insertAt = 0;
    for (let index = defaultIndex - 1; index >= 0; index--) {
      const found = slots.findIndex((slot) => slot.id === allowed[index]);
      if (found >= 0) {
        insertAt = found + 1;
        break;
      }
    }
    slots.splice(insertAt, 0, { id, visible: true });
  });
  return slots;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
