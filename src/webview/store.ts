import { create } from "zustand";
import type {
  AnalyticsQuery,
  AnalyticsResult,
  FreshnessInfo,
  WarningInfo,
  RateLimitInfo,
  DisplayCurrencyConfig,
  HostMessage,
  WebviewRequest,
} from "../shared/protocol";
import type { Source, Effort } from "../shared/types";

// --- VS Code WebView messaging ---

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
export const vscodeApi = acquireVsCodeApi();

// --- Slice interfaces ---

export interface Filters {
  granularity: "day" | "week" | "month" | "year";
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
}

export interface StatusSlice {
  freshness: FreshnessInfo;
  warnings: WarningInfo;
  progress?: { processed: number; total: number; partial: boolean };
  rateLimit?: RateLimitInfo;
  currency?: DisplayCurrencyConfig;
}

interface Actions {
  setFilter: (partial: Partial<Filters>) => void;
  applyResult: (id: string, result: AnalyticsResult) => void;
  setStatus: (status: Partial<StatusSlice>) => void;
  requestQuery: () => void;
}

export interface Store extends Filters, DataSlice, StatusSlice, Actions {}

// --- Helpers ---

let queryCounter = 0;
function nextId(): string {
  return `q-${++queryCounter}`;
}

/** Compute the query range based on granularity — ensures enough data is fetched */
function rangeForGranularity(granularity: string): { fromUtc: number; toUtc: number } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  switch (granularity) {
    case "day": return { fromUtc: now - 14 * day, toUtc: now };       // 2 weeks for comparison
    case "week": return { fromUtc: now - 56 * day, toUtc: now };      // 8 weeks
    case "month": return { fromUtc: now - 180 * day, toUtc: now };    // 6 months
    case "year": return { fromUtc: now - 730 * day, toUtc: now };     // 2 years
    default: return { fromUtc: now - 30 * day, toUtc: now };
  }
}

// --- Store ---

export const useStore = create<Store>((set, get) => ({
  // Filters defaults
  granularity: "day",
  range: rangeForGranularity("day"),
  sources: undefined,
  models: undefined,
  efforts: undefined,
  workspaces: undefined,
  rollupToBaseModel: false,
  breakdownByVariant: false,

  // Data
  results: {},

  // Status
  freshness: {},
  warnings: { unmappedModels: [], malformedLineCount: 0, oversizedLineCount: 0 },
  progress: undefined,
  rateLimit: undefined,
  currency: undefined,

  // Actions
  setFilter(partial) {
    // If granularity changed, update the query range accordingly
    if (partial.granularity && partial.granularity !== get().granularity) {
      partial = { ...partial, range: rangeForGranularity(partial.granularity) };
    }
    // Clear results when filters change so stale data doesn't show
    set({ ...partial, results: {} });
    get().requestQuery();
  },

  applyResult(id, result) {
    // Replace any previous result for the same view type
    set((s) => {
      const newResults: Record<string, AnalyticsResult> = {};
      // Keep results for OTHER views, replace this view
      for (const [k, v] of Object.entries(s.results)) {
        if (v.view !== result.view) { newResults[k] = v; }
      }
      newResults[id] = result;
      return { results: newResults };
    });
  },

  setStatus(status) {
    set(status);
  },

  requestQuery() {
    const s = get();
    const id = nextId();
    // Map "year" to "month" for the protocol (UI handles year grouping locally)
    const queryGranularity = s.granularity === "year" ? "month" : s.granularity;
    const query: AnalyticsQuery = {
      view: "dashboard",
      granularity: queryGranularity,
      range: s.range,
      sources: s.sources,
      models: s.models,
      efforts: s.efforts,
      workspaces: s.workspaces,
      rollupToBaseModel: s.rollupToBaseModel || undefined,
      breakdownByVariant: s.breakdownByVariant || undefined,
    };
    const msg: WebviewRequest = { type: "query", id, query };
    vscodeApi.postMessage(msg);
  },
}));

// --- Host message listener ---

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) {
    return;
  }
  const { applyResult, requestQuery, setStatus } = useStore.getState();
  switch (msg.type) {
    case "queryResult":
      applyResult(msg.id, msg.result);
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
        currency: msg.currency,
      });
      break;
  }
});
