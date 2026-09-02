import { create } from "zustand";
import type {
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsThresholds,
  FreshnessInfo,
  ClaudeRateLimitInfo,
  WarningInfo,
  RateLimitInfo,
  DisplayCurrencyConfig,
  UsageCacheInfo,
  UsagePlanInfo,
  CostAlertRule,
  HostMessage,
  WebviewRequest,
  WorkerHealthInfo,
} from "../shared/protocol";
import type { Source, Effort, PricingTable } from "../shared/types";
import type { AppLanguage } from "../shared/i18n";
import type { HourlyAggregate } from "../shared/storeTypes";
import { queryRangeForPeriod, visibleRangeForPeriod } from "./lib/periodData";
import type { Period } from "./lib/periodData";
import { isValidHostMessage, sanitizePersistedState } from "./messageGuards";

// --- VS Code WebView messaging ---

/** Persisted across WebView reloads by VS Code; survives the panel being hidden. */
export interface PersistedViewState {
  granularity?: Period;
  sources?: Source[];
  language?: AppLanguage;
}

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState: () => PersistedViewState | undefined;
  setState: (state: PersistedViewState) => void;
};
export const vscodeApi = acquireVsCodeApi();

/**
 * VS Code tears the WebView down when the view is hidden and rebuilds it on
 * return. Without this the panel snapped back to "Today / All sources" every
 * time, discarding whatever the reader had selected.
 */
function readPersistedState(): PersistedViewState {
  try {
    // Sanitized, not trusted: this is whatever some earlier version of the
    // extension wrote, and a stale granularity would drive queries nobody
    // handles.
    return sanitizePersistedState(vscodeApi.getState());
  } catch {
    return {};
  }
}

function persistViewState(state: PersistedViewState): void {
  try {
    vscodeApi.setState({ ...readPersistedState(), ...state });
  } catch {
    // Persistence is a convenience; never let it break a filter change.
  }
}

/**
 * Deadline for a host round-trip. The host can go away mid-query (the worker
 * dies, the extension deactivates) and no reply ever arrives; without this the
 * panel sits on a spinner with no way forward.
 */
const REQUEST_TIMEOUT_MS = 30_000;

// --- Slice interfaces ---

export interface Filters {
  granularity: Period;
  range: { fromUtc: number; toUtc: number };
  sources?: Source[];
  models?: string[];
  efforts?: Effort[];
  workspaces?: string[];
  rollupToBaseModel: boolean;
  breakdownByVariant: boolean;
}

export interface DataSlice {
  /**
   * Dashboard results keyed by the filters that produced them, so returning to
   * a tab shows what it showed before instead of re-querying for it.
   */
  results: Record<string, AnalyticsResult>;
  /** Key into `results` for the filters currently on screen. */
  activeKey: string;
  queryPending: boolean;
  queryError?: string;
  dailyHourlySeries: HourlyAggregate[];
  dailyHourlyPending: boolean;
  dailyHourlyError?: string;
}

export interface StatusSlice {
  freshness: FreshnessInfo;
  warnings: WarningInfo;
  progress?: { processed: number; total: number; partial: boolean };
  rateLimit?: RateLimitInfo;
  claudeRateLimit?: ClaudeRateLimitInfo;
  codexUsageCache?: UsageCacheInfo;
  claudeUsageCache?: UsageCacheInfo;
  codexPlan?: UsagePlanInfo;
  claudePlan?: UsagePlanInfo;
  currency?: DisplayCurrencyConfig;
  analytics: AnalyticsThresholds;
  workerHealth?: WorkerHealthInfo;
  /** Warning banners the reader has dismissed this session, by signature. */
  dismissedWarnings: string[];
  costAlertRules: CostAlertRule[];
  costAlertSettingsLoaded: boolean;
  pricingTable: PricingTable;
  pricingSettingsLoaded: boolean;
  language: AppLanguage;
}

interface Actions {
  setFilter: (partial: Partial<Filters>) => void;
  applyResult: (id: string, result: AnalyticsResult) => void;
  applyQueryError: (id: string, message: string) => void;
  setStatus: (status: Partial<StatusSlice>) => void;
  requestQuery: () => void;
  prefetchOtherPeriods: () => void;
  requestDailyHourly: (day: string) => void;
  clearDailyHourly: () => void;
  saveCostAlertRules: (rules: CostAlertRule[]) => Promise<void>;
  savePricingTable: (table: PricingTable) => Promise<void>;
  setLanguage: (language: AppLanguage) => void;
  dismissWarnings: (signature: string) => void;
}

export interface Store extends Filters, DataSlice, StatusSlice, Actions {}

// --- Helpers ---

let queryCounter = 0;
let filterGeneration = 0;
/**
 * Bumped whenever the worker reports the underlying data moved. A cached result
 * carrying the current version is exact, not merely recent, so switching to a
 * tab that holds one needs no query at all.
 */
let dataVersion = 0;
/** The data version each cached result was computed against. */
const resultVersions = new Map<string, number>();
/** Which filters each in-flight request was issued for. */
const queryKeys = new Map<string, string>();
/** The data version each in-flight request was issued under. */
const queryVersions = new Map<string, number>();
/**
 * Enough for every tab and source combination the panel offers, several times
 * over; old entries fall out so a long session cannot grow without bound.
 */
const MAX_CACHED_RESULTS = 24;
/**
 * How often the panel re-asks while a first scan is still running.
 *
 * Long enough that a scan is not competing with a query for the worker on
 * every progress tick, short enough that the first numbers appear while the
 * scan is still going rather than at the end of it.
 */
const SCAN_REFRESH_INTERVAL_MS = 1_500;
let lastScanRefreshAt = 0;
/**
 * Every period the tabs offer. The one on screen is fetched normally; the
 * rest are pulled in behind it so the first switch is as quick as the second.
 */
const ALL_PERIODS: Period[] = ["today", "day", "week", "month", "year"];


/** Midnight today, so a cached result cannot outlive the day it describes. */
function localDayKey(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Identity of a set of filters, as far as the worker is concerned.
 *
 * `toUtc` is deliberately absent: it is always "now", so including it would
 * make every key unique and the cache useless. What it guards against — data
 * arriving after the result was computed — is `dataVersion`'s job, and the
 * local day is in the key so crossing midnight invalidates everything.
 */
function filterKey(f: Filters): string {
  const { fromUtc } = queryRangeForPeriod(f.granularity);
  return JSON.stringify([
    f.granularity,
    fromUtc,
    localDayKey(),
    [...(f.sources ?? [])].sort(),
    f.models ?? [],
    f.efforts ?? [],
    f.workspaces ?? [],
    f.rollupToBaseModel,
    f.breakdownByVariant,
  ]);
}

/**
 * What the worker is asked for a given period.
 *
 * Shared by the live request and the background prefetch: if the two built
 * their queries separately they could ask different questions and land under
 * the same cache key, which is worse than not caching at all.
 */
function buildQuery(filters: Filters, granularity: Period): AnalyticsQuery {
  return {
    view: "dashboard",
    // "year" is grouped by month on the wire; the UI does the yearly rollup.
    granularity: granularity === "year" ? "month" : granularity === "today" ? "day" : granularity,
    range: queryRangeForPeriod(granularity),
    // The hourly chart only ever shows today; asking for it explicitly keeps it
    // working no matter how far back the aggregate range reaches.
    hourlyRange: todayHourlyRange(),
    // Tools and sessions are rendered whole, so they follow the visible period
    // rather than the wider range the baseline needs.
    visibleRange: visibleRangeForPeriod(granularity),
    sources: filters.sources,
    models: filters.models,
    efforts: filters.efforts,
    workspaces: filters.workspaces,
    rollupToBaseModel: filters.rollupToBaseModel || undefined,
    breakdownByVariant: filters.breakdownByVariant || undefined,
  };
}

/** Keep the cache bounded, evicting whatever was stored longest ago. */
function evict(results: Record<string, AnalyticsResult>, keep: string): Record<string, AnalyticsResult> {
  const keys = Object.keys(results);
  if (keys.length <= MAX_CACHED_RESULTS) { return results; }
  const trimmed = { ...results };
  for (const key of keys.slice(0, keys.length - MAX_CACHED_RESULTS)) {
    if (key === keep) { continue; }
    delete trimmed[key];
    resultVersions.delete(key);
  }
  return trimmed;
}
let activeQueryId: string | undefined;
let activeQueryTimer: ReturnType<typeof setTimeout> | undefined;
let activeDailyHourlyQueryId: string | undefined;
let activeDailyHourlyTimer: ReturnType<typeof setTimeout> | undefined;
let currentDailyHourlyDay: string | undefined;
/** Filter generation the currently displayed drill-down was fetched under. */
let dailyHourlyFilterGeneration = 0;
let refreshQueued = false;
let costAlertSaveCounter = 0;
let pricingSaveCounter = 0;
const pendingCostAlertSaves = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const pendingPricingSaves = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function nextId(): string {
  return `q-${++queryCounter}`;
}

function clearActiveQueryTimer(): void {
  if (activeQueryTimer !== undefined) {
    clearTimeout(activeQueryTimer);
    activeQueryTimer = undefined;
  }
}

function clearDailyHourlyTimer(): void {
  if (activeDailyHourlyTimer !== undefined) {
    clearTimeout(activeDailyHourlyTimer);
    activeDailyHourlyTimer = undefined;
  }
}

// --- Store ---

const persisted = readPersistedState();

export const useStore = create<Store>((set, get) => ({
  // Filters defaults, restored from the last session where available.
  granularity: persisted.granularity ?? "today",
  range: queryRangeForPeriod(persisted.granularity ?? "today"),
  sources: persisted.sources,
  models: undefined,
  efforts: undefined,
  workspaces: undefined,
  rollupToBaseModel: false,
  breakdownByVariant: false,

  // Data
  results: {},
  activeKey: filterKey({
    granularity: persisted.granularity ?? "today",
    range: queryRangeForPeriod(persisted.granularity ?? "today"),
    sources: persisted.sources,
    rollupToBaseModel: false,
    breakdownByVariant: false,
  }),
  queryPending: false,
  queryError: undefined,
  dailyHourlySeries: [],
  dailyHourlyPending: false,
  dailyHourlyError: undefined,

  // Status
  freshness: {},
  warnings: { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0, lostUsageLineCount: 0 },
  progress: undefined,
  rateLimit: undefined,
  claudeRateLimit: undefined,
  codexUsageCache: undefined,
  claudeUsageCache: undefined,
  codexPlan: undefined,
  claudePlan: undefined,
  currency: undefined,
  analytics: { anomalyMultiplier: 2, contextFillWarnPct: 80 },
  workerHealth: undefined,
  dismissedWarnings: [],
  costAlertRules: [],
  costAlertSettingsLoaded: false,
  pricingTable: {},
  pricingSettingsLoaded: false,
  language: persisted.language ?? "en",

  // Actions
  setFilter(partial) {
    filterGeneration++;
    // If granularity changed, update the query range accordingly
    if (partial.granularity && partial.granularity !== get().granularity) {
      partial = { ...partial, range: queryRangeForPeriod(partial.granularity as Period) };
    }
    // Results are NOT cleared here. Every tab used to drop the whole cache and
    // re-query, so returning to a tab visited seconds ago rebuilt it from
    // scratch and the panel blanked in the meantime — on a large database that
    // reads as the extension reloading itself. Keyed by filters, a revisit is
    // an object lookup.
    const key = filterKey({ ...get(), ...partial } as Filters);
    set({
      ...partial,
      activeKey: key,
      // A hit for the current data version needs nothing; a stale hit still
      // renders while the refresh runs, so the numbers never blank out.
      queryPending: get().results[key] === undefined,
      queryError: undefined,
      // The drill-down is a separate query against the same filters, so it is
      // stale for the same reason and has to be re-run, not just re-labelled.
      ...(currentDailyHourlyDay ? { dailyHourlySeries: [], dailyHourlyError: undefined } : {}),
    });
    const next = get();
    persistViewState({ granularity: next.granularity, sources: next.sources });
    if (next.results[key] !== undefined && resultVersions.get(key) === dataVersion) {
      // Exact, not merely recent: the data has not moved since this was built.
      return;
    }
    next.requestQuery();
    // The drill-down is NOT re-requested here: DayUsageTrend's own effect
    // depends on the filters and fires for the same change, so doing it here
    // too sent the query twice.
  },

  applyResult(id, result) {
    const key = queryKeys.get(id);
    queryKeys.delete(id);
    if (key === undefined) { return; }

    // Cache it under the filters it was asked for, even if the reader has since
    // moved on: it is exactly what that tab will need when they come back.
    const version = queryVersions.get(id) ?? dataVersion;
    queryVersions.delete(id);
    resultVersions.set(key, version);
    set((s) => ({ results: evict({ ...s.results, [key]: result }, s.activeKey) }));

    if (id !== activeQueryId) { return; }
    activeQueryId = undefined;
    clearActiveQueryTimer();
    set((s) => (key === s.activeKey
      ? { queryPending: false, queryError: undefined }
      : { queryPending: false }));
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(() => get().requestQuery());
      return;
    }
    // The tab in front of the reader is drawn; pull the others in behind it so
    // the first switch does not wait on a query either.
    get().prefetchOtherPeriods();
  },

  applyQueryError(id, message) {
    queryKeys.delete(id);
    queryVersions.delete(id);
    if (id !== activeQueryId) {
      return;
    }
    activeQueryId = undefined;
    clearActiveQueryTimer();
    set({ queryPending: false, queryError: message });
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(() => get().requestQuery());
    }
  },

  setStatus(status) {
    set(status);
  },

  requestQuery() {
    if (activeQueryId) {
      refreshQueued = true;
      return;
    }
    const s = get();
    const id = nextId();
    activeQueryId = id;
    queryKeys.set(id, s.activeKey);
    // Captured before the request goes out: anything that changes the data
    // while it is in flight must invalidate the answer, not be absorbed by it.
    queryVersions.set(id, dataVersion);
    const range = queryRangeForPeriod(s.granularity);
    if (range.fromUtc !== s.range.fromUtc || range.toUtc !== s.range.toUtc) {
      set({ range });
    }
    const msg: WebviewRequest = { type: "query", id, query: buildQuery(s, s.granularity) };
    // Only blank the panel when there is nothing cached to show meanwhile.
    set((prev) => ({
      queryPending: prev.results[prev.activeKey] === undefined,
      queryError: undefined,
    }));
    clearActiveQueryTimer();
    activeQueryTimer = setTimeout(() => {
      get().applyQueryError(id, "The extension host did not answer in time.");
    }, REQUEST_TIMEOUT_MS);
    vscodeApi.postMessage(msg);
  },

  /**
   * Quietly fetch the periods the reader is not looking at.
   *
   * Switching tabs is already free once a period has been seen, but the first
   * visit still waited on a query. The whole set costs the worker about 130 ms
   * and runs when the browser is idle, so it is paid before anyone asks rather
   * than in front of them.
   */
  prefetchOtherPeriods() {
    // No separate guard against repeating: whether a period is worth fetching
    // is already decided per key below, and a version-wide flag got it wrong —
    // changing the source filter needs a different set fetched at the same
    // version.
    const state = get();
    const pending = ALL_PERIODS.filter((granularity) => {
      if (granularity === state.granularity) { return false; }
      const key = filterKey({ ...state, granularity } as Filters);
      return state.results[key] === undefined || resultVersions.get(key) !== dataVersion;
    });
    if (pending.length === 0) { return; }

    const runWhenIdle = (fn: () => void): void => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
      if (typeof idle === "function") { idle(fn); } else { setTimeout(fn, 0); }
    };

    for (const granularity of pending) {
      runWhenIdle(() => {
        const now = get();
        const key = filterKey({ ...now, granularity } as Filters);
        // The reader may have arrived here first, or the data may have moved on.
        if (now.results[key] !== undefined && resultVersions.get(key) === dataVersion) { return; }
        const id = nextId();
        queryKeys.set(id, key);
        queryVersions.set(id, dataVersion);
        // Deliberately not the active request: this must not put the panel into
        // a pending state, and its answer is only ever wanted in the cache.
        vscodeApi.postMessage({
          type: "query",
          id,
          query: buildQuery(now, granularity),
        } satisfies WebviewRequest);
      });
    }
  },

  requestDailyHourly(day) {
    const s = get();
    const id = nextId();
    const dayChanged = currentDailyHourlyDay !== day;
    const filtersChanged = dailyHourlyFilterGeneration !== filterGeneration;
    dailyHourlyFilterGeneration = filterGeneration;
    activeDailyHourlyQueryId = id;
    currentDailyHourlyDay = day;
    const start = localDayStart(day);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setMilliseconds(-1);
    const query: AnalyticsQuery = {
      view: "hourly",
      granularity: "day",
      range: { fromUtc: start.getTime(), toUtc: end.getTime() },
      sources: s.sources,
      models: s.models,
      efforts: s.efforts,
      workspaces: s.workspaces,
      rollupToBaseModel: s.rollupToBaseModel || undefined,
      breakdownByVariant: s.breakdownByVariant || undefined,
    };
    // Drop the previous day's series when the selection moves: showing one
    // day's bars under another day's heading is worse than showing none.
    set({
      dailyHourlyPending: true,
      dailyHourlyError: undefined,
      ...(dayChanged || filtersChanged ? { dailyHourlySeries: [] } : {}),
    });
    clearDailyHourlyTimer();
    activeDailyHourlyTimer = setTimeout(() => {
      if (activeDailyHourlyQueryId !== id) { return; }
      activeDailyHourlyQueryId = undefined;
      activeDailyHourlyTimer = undefined;
      useStore.setState({ dailyHourlyPending: false, dailyHourlyError: "The extension host did not answer in time." });
    }, REQUEST_TIMEOUT_MS);
    vscodeApi.postMessage({ type: "query", id, query } satisfies WebviewRequest);
  },

  clearDailyHourly() {
    activeDailyHourlyQueryId = undefined;
    currentDailyHourlyDay = undefined;
    clearDailyHourlyTimer();
    set({ dailyHourlySeries: [], dailyHourlyPending: false, dailyHourlyError: undefined });
  },

  saveCostAlertRules(rules) {
    const requestId = `cost-alert-save-${++costAlertSaveCounter}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCostAlertSaves.delete(requestId);
        reject(new Error("The extension host did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      pendingCostAlertSaves.set(requestId, { resolve, reject, timer });
      const msg: WebviewRequest = { type: "saveCostAlertSettings", requestId, rules };
      vscodeApi.postMessage(msg);
    });
  },

  savePricingTable(table) {
    const requestId = `pricing-save-${++pricingSaveCounter}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingPricingSaves.delete(requestId);
        reject(new Error("The extension host did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      pendingPricingSaves.set(requestId, { resolve, reject, timer });
      vscodeApi.postMessage({ type: "savePricingSettings", requestId, table } satisfies WebviewRequest);
    });
  },

  setLanguage(language) {
    const msg: WebviewRequest = { type: "setLanguage", language };
    vscodeApi.postMessage(msg);
  },

  dismissWarnings(signature) {
    const dismissed = get().dismissedWarnings;
    if (dismissed.includes(signature)) { return; }
    set({ dismissedWarnings: [...dismissed, signature] });
  },
}));

// --- Host message listener ---

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  // Shape-checked before any reducer touches it: a malformed payload used to
  // throw inside a render and blank the whole panel.
  if (!isValidHostMessage(msg)) {
    if (msg && typeof msg === "object") {
      console.warn("[TokenWatch] ignored a malformed host message", (msg as { type?: unknown }).type);
    }
    return;
  }
  const { applyResult, applyQueryError, requestQuery, setStatus } = useStore.getState();
  switch (msg.type) {
    case "queryResult":
      if (msg.result.view === "hourly") {
        if (msg.id === activeDailyHourlyQueryId) {
          activeDailyHourlyQueryId = undefined;
          clearDailyHourlyTimer();
          useStore.setState({ dailyHourlySeries: msg.result.hourlySeries, dailyHourlyPending: false, dailyHourlyError: undefined });
        }
      } else {
        applyResult(msg.id, msg.result);
      }
      break;
    case "queryError":
      if (msg.id === activeDailyHourlyQueryId) {
        activeDailyHourlyQueryId = undefined;
        clearDailyHourlyTimer();
        useStore.setState({ dailyHourlyPending: false, dailyHourlyError: msg.message });
      } else {
        applyQueryError(msg.id, msg.message);
      }
      break;
    case "dataChanged":
      // Every cached result now describes a database that has moved on. They
      // stay on screen so nothing flickers, but each is marked stale and will
      // be rebuilt the next time its tab is shown.
      dataVersion++;
      requestQuery();
      if (currentDailyHourlyDay) {
        useStore.getState().requestDailyHourly(currentDailyHourlyDay);
      }
      break;
    case "ingestProgress": {
      useStore.setState({
        progress: { processed: msg.processed, total: msg.total, partial: msg.partial },
      });
      // A first scan finds rows long before it finishes. Nothing used to ask
      // again until it ended, so a fresh install watched a progress bar for the
      // whole pass and then everything appeared at once. While there is still
      // nothing to draw, ask again as the scan turns up more.
      const state = useStore.getState();
      const shown = state.results[state.activeKey];
      const hasRows = shown !== undefined
        && (shown.view !== "dashboard" || shown.series.length > 0);
      const now = Date.now();
      if (msg.partial && !hasRows && now - lastScanRefreshAt >= SCAN_REFRESH_INTERVAL_MS) {
        lastScanRefreshAt = now;
        // The rows are arriving as this runs, so whatever is cached for these
        // filters is already behind.
        dataVersion++;
        state.requestQuery();
      }
      break;
    }
    case "costAlertSettings":
      useStore.setState({ costAlertRules: msg.rules, costAlertSettingsLoaded: true });
      break;
    case "costAlertSettingsSaved": {
      useStore.setState({ costAlertRules: msg.rules, costAlertSettingsLoaded: true });
      const pending = pendingCostAlertSaves.get(msg.requestId);
      pendingCostAlertSaves.delete(msg.requestId);
      if (pending) { clearTimeout(pending.timer); }
      pending?.resolve();
      break;
    }
    case "costAlertSettingsError": {
      const pending = pendingCostAlertSaves.get(msg.requestId);
      pendingCostAlertSaves.delete(msg.requestId);
      if (pending) { clearTimeout(pending.timer); }
      pending?.reject(new Error(msg.message));
      break;
    }
    case "pricingSettings":
      useStore.setState({ pricingTable: msg.table, pricingSettingsLoaded: true });
      break;
    case "pricingSettingsSaved": {
      useStore.setState({ pricingTable: msg.table, pricingSettingsLoaded: true });
      const pending = pendingPricingSaves.get(msg.requestId);
      pendingPricingSaves.delete(msg.requestId);
      if (pending) { clearTimeout(pending.timer); }
      pending?.resolve();
      break;
    }
    case "pricingSettingsError": {
      const pending = pendingPricingSaves.get(msg.requestId);
      pendingPricingSaves.delete(msg.requestId);
      if (pending) { clearTimeout(pending.timer); }
      pending?.reject(new Error(msg.message));
      break;
    }
    case "language":
      useStore.setState({ language: msg.language });
      persistViewState({ language: msg.language });
      document.documentElement.lang = msg.language;
      break;
    case "status":
      setStatus({
        freshness: msg.freshness,
        warnings: msg.warnings,
        rateLimit: msg.rateLimit,
        claudeRateLimit: msg.claudeRateLimit,
        codexUsageCache: msg.codexUsageCache,
        claudeUsageCache: msg.claudeUsageCache,
        codexPlan: msg.codexPlan,
        claudePlan: msg.claudePlan,
        currency: msg.currency,
        ...(msg.analytics ? { analytics: msg.analytics } : {}),
        workerHealth: msg.workerHealth,
      });
      break;
  }
});

/** Local bounds of today, for the dashboard's hourly series. */
function todayHourlyRange(): { fromUtc: number; toUtc: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { fromUtc: start.getTime(), toUtc: end.getTime() - 1 };
}

function localDayStart(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}
