import { useEffect } from "react";
import { useStore } from "../store.js";
import type { AnalyticsQuery, AnalyticsResult } from "../../shared/protocol.js";

/**
 * Returns the LATEST cached `AnalyticsResult` for the given view.
 * When filters change, a new query is sent and the newest result replaces the old.
 */
export function useQuery(view: AnalyticsQuery["view"]): AnalyticsResult | undefined {
  const result = useStore((s) => {
    // Find the most recent result matching this view (highest id = most recent)
    let latest: AnalyticsResult | undefined;
    let latestId = "";
    for (const [id, r] of Object.entries(s.results)) {
      if (r.view === view && id > latestId) {
        latest = r;
        latestId = id;
      }
    }
    return latest;
  });

  const requestQuery = useStore((s) => s.requestQuery);

  useEffect(() => {
    if (!result) {
      requestQuery();
    }
  }, [result, requestQuery]);

  return result;
}
