import { useStore } from "../store";
import { ProviderUsageCard } from "./ProviderUsageCard";
import { useTranslation } from "../i18n";

export function TodayClaudeUsageCard() {
  const rateLimit = useStore((s) => s.claudeRateLimit);
  const cacheInfo = useStore((s) => s.claudeUsageCache);
  const { t } = useTranslation();
  if (!rateLimit && !cacheInfo) {
    return null;
  }

  return <ProviderUsageCard provider="claude" title={t("quota.claude")} windows={rateLimit?.windows ?? []} cacheInfo={cacheInfo} />;
}
