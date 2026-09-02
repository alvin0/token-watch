import { useStore } from "../store.js";
import type { AnalyticsQuery, AnalyticsResult } from "../../shared/protocol.js";

/**
 * The cached `AnalyticsResult` for the filters currently on screen.
 *
 * Results are keyed by the filters that produced them, so this is a lookup:
 * switching to a tab that has been shown before renders immediately, with no
 * request and no blank frame. Query scheduling stays in the store so the eleven
 * cards reading this do not each emit their own request.
 *
 * Returns `undefined` only when this tab has genuinely never been loaded. A
 * result that is merely stale is still returned — the refresh happens behind
 * it, which is far better than showing the reader nothing.
 */
export function useQuery(view: AnalyticsQuery["view"]): AnalyticsResult | undefined {
  return useStore((s) => {
    const result = s.results[s.activeKey];
    return result?.view === view ? result : undefined;
  });
}
