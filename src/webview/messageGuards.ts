/**
 * Runtime shape checks for everything crossing into the WebView.
 *
 * The host and the WebView are separate processes with an untyped
 * `postMessage` between them, and `getState()` returns whatever a previous
 * version of this extension persisted. TypeScript checks neither: a malformed
 * or stale payload used to reach a reducer and throw inside a React render,
 * which blanks the panel with no way back except reopening it.
 *
 * These guards are deliberately shallow — they check the shape each handler
 * actually dereferences, and let anything else through untouched rather than
 * duplicating the protocol as a schema.
 */

import type { HostMessage } from "../shared/protocol";
import type { PersistedViewState } from "./store";
import type { Period } from "./lib/periodData";
import { isAppLanguage } from "../shared/i18n";

const PERIODS: readonly Period[] = ["today", "day", "week", "month", "year"];
const SOURCES = ["codex", "claude"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a message from the host is safe to hand to a reducer.
 *
 * Returns false for anything whose required fields are missing or the wrong
 * type; the caller ignores it rather than throwing mid-render.
 */
export function isValidHostMessage(value: unknown): value is HostMessage {
  if (!isObject(value) || typeof value.type !== "string") { return false; }

  switch (value.type) {
    case "queryResult":
      return typeof value.id === "string" && isValidAnalyticsResult(value.result);
    case "queryError":
      return typeof value.id === "string" && typeof value.message === "string";
    case "dataChanged":
      return true;
    case "ingestProgress":
      return isFiniteNumber(value.processed) && isFiniteNumber(value.total) && typeof value.partial === "boolean";
    case "costAlertSettings":
      return Array.isArray(value.rules);
    case "costAlertSettingsSaved":
    case "pricingSettingsSaved":
      return typeof value.requestId === "string";
    case "costAlertSettingsError":
    case "pricingSettingsError":
      return typeof value.requestId === "string" && typeof value.message === "string";
    case "pricingSettings":
      return isObject(value.table);
    case "language":
      return isAppLanguage(value.language);
    case "status":
      // The only two fields every consumer dereferences unconditionally.
      return isObject(value.freshness) && isValidWarnings(value.warnings);
    default:
      // An unknown type is from a newer host; the switch ignores it anyway.
      return true;
  }
}

/**
 * Every array a result's consumers iterate must be present.
 *
 * Checking only `view` was not enough: a dashboard payload carrying just
 * `series` passed, and the first card to reach `contextSessions.filter(...)`
 * threw inside a render and blanked the panel.
 */
function isValidAnalyticsResult(value: unknown): boolean {
  if (!isObject(value) || typeof value.view !== "string") { return false; }
  const required = RESULT_ARRAYS[value.view];
  if (!required) { return false; }
  return required.every((field) => Array.isArray(value[field]));
}

/** The arrays each view promises, keyed by `AnalyticsResult["view"]`. */
const RESULT_ARRAYS: Record<string, readonly string[]> = {
  dashboard: ["series", "variants", "sessions", "contextSessions", "tools", "toolCallsByDay", "hourlySeries"],
  hourly: ["hourlySeries"],
  series: ["series"],
  variants: ["variants"],
  sessions: ["sessions"],
  tools: ["tools"],
  heatmap: ["heatmap"],
  comparison: ["comparison"],
};

function isValidWarnings(value: unknown): boolean {
  return isObject(value)
    && Array.isArray(value.unmappedModels)
    && isFiniteNumber(value.malformedLineCount)
    && isFiniteNumber(value.oversizedLineCount);
}

/**
 * Sanitize state persisted by a previous session.
 *
 * `getState()` can return anything an older build wrote, including a period
 * that no longer exists. Unrecognised values are dropped rather than trusted.
 */
export function sanitizePersistedState(value: unknown): PersistedViewState {
  if (!isObject(value)) { return {}; }
  const state: PersistedViewState = {};

  if (typeof value.granularity === "string" && (PERIODS as readonly string[]).includes(value.granularity)) {
    state.granularity = value.granularity as Period;
  }
  if (Array.isArray(value.sources)) {
    const sources = value.sources.filter(
      (source): source is typeof SOURCES[number] => (SOURCES as readonly unknown[]).includes(source),
    );
    if (sources.length > 0) { state.sources = sources; }
  }
  if (isAppLanguage(value.language)) {
    state.language = value.language;
  }
  return state;
}
