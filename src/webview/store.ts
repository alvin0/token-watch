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
  HostMessage,
  WebviewRequest,
} from "../shared/protocol";
import type { Source, Effort } from "../shared/types";
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
}

interface Actions {
  setFilter: (partial: Partial<Filters>) => void;
  applyResult: (id: string, result: AnalyticsResult) => void;
  applyQueryError: (id: string, message: string) => void;
  setStatus: (status: Partial<StatusSlice>) => void;
  requestQuery: () => void;
}

export interface Store extends Filters, DataSlice, StatusSlice, Actions {}

// --- Helpers ---

let queryCounter = 0;
let filterGeneration = 0;
let activeQueryId: string | undefined;
let refreshQueued = false;
const queryGenerations = new Map<string, number>();
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

  // Status
  freshness: {},
  warnings: { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0 },
  progress: undefined,
  rateLimit: undefined,
  claudeRateLimit: undefined,
  codexUsageCache: undefined,
  claudeUsageCache: undefined,
  currency: undefined,

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
      applyResult(msg.id, msg.result);
      break;
    case "queryError":
      applyQueryError(msg.id, msg.message);
      break;
    case "dataChanged":
      requestQuery();
      break;
    case "ingestProgress":
      useStore.setState({
        progress: { processed: msg.processed, total: msg.total, partial: msg.partial },
      });
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
