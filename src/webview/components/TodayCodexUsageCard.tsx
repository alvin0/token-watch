import { useStore } from "../store";
import { ProviderUsageCard } from "./ProviderUsageCard";

export function TodayCodexUsageCard() {
  const rateLimit = useStore((s) => s.rateLimit);
  const cacheInfo = useStore((s) => s.codexUsageCache);
  if (!rateLimit && !cacheInfo) {
    return null;
  }

  return <ProviderUsageCard provider="codex" title="Codex Usage" windows={rateLimit?.windows ?? []} cacheInfo={cacheInfo} />;
}
