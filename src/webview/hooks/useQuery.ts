import { useStore } from "../store.js";
import type { AnalyticsQuery, AnalyticsResult } from "../../shared/protocol.js";

/**
 * Returns the latest cached `AnalyticsResult` for the given view. Query
 * scheduling is centralized in the store/main entry point so multiple cards do
 * not emit duplicate requests while the same result is pending.
 */
export function useQuery(view: AnalyticsQuery["view"]): AnalyticsResult | undefined {
  const result = useStore((s) => {
    // Find the most recent result matching this view (highest numeric counter = most recent)
    let latest: AnalyticsResult | undefined;
    let latestNum = -1;
    for (const [id, r] of Object.entries(s.results)) {
      if (r.view === view) {
        const num = parseInt(id.slice(2), 10); // "q-123" → 123
        if (num > latestNum) {
          latest = r;
          latestNum = num;
        }
      }
    }
    return latest;
  });

  return result;
}
