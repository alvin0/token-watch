import { useStore } from "../store";
import { ProviderUsageCard } from "./ProviderUsageCard";

export function TodayClaudeUsageCard() {
  const rateLimit = useStore((s) => s.claudeRateLimit);
  const cacheInfo = useStore((s) => s.claudeUsageCache);
  if (!rateLimit && !cacheInfo) {
    return null;
  }

  return <ProviderUsageCard provider="claude" title="Claude Code Usage" windows={rateLimit?.windows ?? []} cacheInfo={cacheInfo} />;
}
