import { create } from "zustand";
import type {
  AnalyticsQuery,
  AnalyticsResult,
  FreshnessInfo,
  ClaudeRateLimitInfo,
  WarningInfo,
  RateLimitInfo,
  DisplayCurrencyConfig,
  UsageCacheInfo,
  CostAlertRule,
  HostMessage,
  WebviewRequest,
} from "../shared/protocol";
import type { Source, Effort, PricingTable } from "../shared/types";
import type { AppLanguage } from "../shared/i18n";
import type { HourlyAggregate } from "../shared/storeTypes";
import { queryRangeForPeriod } from "./lib/periodData";
import type { Period } from "./lib/periodData";

// --- VS Code WebView messaging ---

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
export const vscodeApi = acquireVsCodeApi();

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
  results: Record<string, AnalyticsResult>;
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
  currency?: DisplayCurrencyConfig;
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
  requestDailyHourly: (day: string) => void;
  clearDailyHourly: () => void;
  saveCostAlertRules: (rules: CostAlertRule[]) => Promise<void>;
  savePricingTable: (table: PricingTable) => Promise<void>;
  setLanguage: (language: AppLanguage) => void;
}

export interface Store extends Filters, DataSlice, StatusSlice, Actions {}

// --- Helpers ---

let queryCounter = 0;
let filterGeneration = 0;
let activeQueryId: string | undefined;
let activeDailyHourlyQueryId: string | undefined;
let currentDailyHourlyDay: string | undefined;
let refreshQueued = false;
let costAlertSaveCounter = 0;
let pricingSaveCounter = 0;
const queryGenerations = new Map<string, number>();
const pendingCostAlertSaves = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const pendingPricingSaves = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
function nextId(): string {
  return `q-${++queryCounter}`;
}

// --- Store ---

export const useStore = create<Store>((set, get) => ({
  // Filters defaults
  granularity: "today",
  range: queryRangeForPeriod("today"),
  sources: undefined,
  models: undefined,
  efforts: undefined,
  workspaces: undefined,
  rollupToBaseModel: false,
  breakdownByVariant: false,

  // Data
  results: {},
  queryPending: false,
  queryError: undefined,
  dailyHourlySeries: [],
  dailyHourlyPending: false,
  dailyHourlyError: undefined,

  // Status
  freshness: {},
  warnings: { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0 },
  progress: undefined,
  rateLimit: undefined,
  claudeRateLimit: undefined,
  codexUsageCache: undefined,
  claudeUsageCache: undefined,
  currency: undefined,
  costAlertRules: [],
  costAlertSettingsLoaded: false,
  pricingTable: {},
  pricingSettingsLoaded: false,
  language: "en",

  // Actions
  setFilter(partial) {
    filterGeneration++;
    // If granularity changed, update the query range accordingly
    if (partial.granularity && partial.granularity !== get().granularity) {
      partial = { ...partial, range: queryRangeForPeriod(partial.granularity as Period) };
    }
    // Clear results when filters change so stale data doesn't show
    set({ ...partial, results: {} });
    get().requestQuery();
  },

  applyResult(id, result) {
    const generation = queryGenerations.get(id);
    queryGenerations.delete(id);
    if (id !== activeQueryId) {
      return;
    }
    activeQueryId = undefined;
    const shouldApply = generation === filterGeneration;
    // Replace any previous result for the same view type
    if (shouldApply) { set((s) => {
      const newResults: Record<string, AnalyticsResult> = {};
      // Keep results for OTHER views, replace this view
      for (const [k, v] of Object.entries(s.results)) {
        if (v.view !== result.view) { newResults[k] = v; }
      }
      newResults[id] = result;
      return { results: newResults, queryPending: false, queryError: undefined };
    }); } else {
      set({ queryPending: false });
    }
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(() => get().requestQuery());
    }
  },

  applyQueryError(id, message) {
    queryGenerations.delete(id);
    if (id !== activeQueryId) {
      return;
    }
    activeQueryId = undefined;
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
    queryGenerations.set(id, filterGeneration);
    const range = queryRangeForPeriod(s.granularity);
    if (range.fromUtc !== s.range.fromUtc || range.toUtc !== s.range.toUtc) {
      set({ range });
    }
    // Map "year" to "month" for the protocol (UI handles year grouping locally)
    const queryGranularity = s.granularity === "year" ? "month" : s.granularity === "today" ? "day" : s.granularity;
    const query: AnalyticsQuery = {
      view: "dashboard",
      granularity: queryGranularity,
      range,
      sources: s.sources,
      models: s.models,
      efforts: s.efforts,
      workspaces: s.workspaces,
      rollupToBaseModel: s.rollupToBaseModel || undefined,
      breakdownByVariant: s.breakdownByVariant || undefined,
    };
    const msg: WebviewRequest = { type: "query", id, query };
    set({ queryPending: true, queryError: undefined });
    vscodeApi.postMessage(msg);
  },

  requestDailyHourly(day) {
    const s = get();
    const id = nextId();
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
    set({ dailyHourlyPending: true, dailyHourlyError: undefined });
    vscodeApi.postMessage({ type: "query", id, query } satisfies WebviewRequest);
  },

  clearDailyHourly() {
    activeDailyHourlyQueryId = undefined;
    currentDailyHourlyDay = undefined;
    set({ dailyHourlySeries: [], dailyHourlyPending: false, dailyHourlyError: undefined });
  },

  saveCostAlertRules(rules) {
    const requestId = `cost-alert-save-${++costAlertSaveCounter}`;
    return new Promise<void>((resolve, reject) => {
      pendingCostAlertSaves.set(requestId, { resolve, reject });
      const msg: WebviewRequest = { type: "saveCostAlertSettings", requestId, rules };
      vscodeApi.postMessage(msg);
    });
  },

  savePricingTable(table) {
    const requestId = `pricing-save-${++pricingSaveCounter}`;
    return new Promise<void>((resolve, reject) => {
      pendingPricingSaves.set(requestId, { resolve, reject });
      vscodeApi.postMessage({ type: "savePricingSettings", requestId, table } satisfies WebviewRequest);
    });
  },

  setLanguage(language) {
    const msg: WebviewRequest = { type: "setLanguage", language };
    vscodeApi.postMessage(msg);
  },
}));

// --- Host message listener ---

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) {
    return;
  }
  const { applyResult, applyQueryError, requestQuery, setStatus } = useStore.getState();
  switch (msg.type) {
    case "queryResult":
      if (msg.result.view === "hourly") {
        if (msg.id === activeDailyHourlyQueryId) {
          activeDailyHourlyQueryId = undefined;
          useStore.setState({ dailyHourlySeries: msg.result.hourlySeries, dailyHourlyPending: false, dailyHourlyError: undefined });
        }
      } else {
        applyResult(msg.id, msg.result);
      }
      break;
    case "queryError":
      if (msg.id === activeDailyHourlyQueryId) {
        activeDailyHourlyQueryId = undefined;
        useStore.setState({ dailyHourlyPending: false, dailyHourlyError: msg.message });
      } else {
        applyQueryError(msg.id, msg.message);
      }
      break;
    case "dataChanged":
      requestQuery();
      if (currentDailyHourlyDay) {
        useStore.getState().requestDailyHourly(currentDailyHourlyDay);
      }
      break;
    case "ingestProgress":
      useStore.setState({
        progress: { processed: msg.processed, total: msg.total, partial: msg.partial },
      });
      break;
    case "costAlertSettings":
      useStore.setState({ costAlertRules: msg.rules, costAlertSettingsLoaded: true });
      break;
    case "costAlertSettingsSaved": {
      useStore.setState({ costAlertRules: msg.rules, costAlertSettingsLoaded: true });
      const pending = pendingCostAlertSaves.get(msg.requestId);
      pendingCostAlertSaves.delete(msg.requestId);
      pending?.resolve();
      break;
    }
    case "costAlertSettingsError": {
      const pending = pendingCostAlertSaves.get(msg.requestId);
      pendingCostAlertSaves.delete(msg.requestId);
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
      pending?.resolve();
      break;
    }
    case "pricingSettingsError": {
      const pending = pendingPricingSaves.get(msg.requestId);
      pendingPricingSaves.delete(msg.requestId);
      pending?.reject(new Error(msg.message));
      break;
    }
    case "language":
      useStore.setState({ language: msg.language });
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
        currency: msg.currency,
      });
      break;
  }
});

function localDayStart(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}
