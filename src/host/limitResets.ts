import type { CodexConnection } from "../provider/codex";
import { mapCodexLimitResets, type CodexLimitResetsResponse } from "../shared/codexUsage";
import type { UsageLimitResetsInfo } from "../shared/protocol";

export type LimitResetsFetcher = (options: { force?: boolean }) => Promise<CodexLimitResetsResponse>;

export function codexLimitResetsFetcher(connection: CodexConnection): LimitResetsFetcher {
  return (options) => connection.limitResetsInfo<CodexLimitResetsResponse>(options);
}

/**
 * Attach each usage limit reset (and its expiry) to the counts carried on the
 * usage payload. Only fetched when the account actually has resets left, and
 * best-effort: the counts still stand when the extra request fails.
 */
export async function withLimitResetDetails(
  fetchResets: LimitResetsFetcher,
  counts: UsageLimitResetsInfo | undefined,
  force = false,
): Promise<UsageLimitResetsInfo | undefined> {
  if (!counts || counts.availableCount <= 0) {
    return counts;
  }

  try {
    const resets = mapCodexLimitResets(await fetchResets({ force }));
    return resets.length > 0 ? { ...counts, resets } : counts;
  } catch (error) {
    console.warn("[TokenWatch] Codex usage limit resets refresh failed:", error);
    return counts;
  }
}
