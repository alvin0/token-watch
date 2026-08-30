import { useStore } from "../store";
import { ProviderUsageCard } from "./ProviderUsageCard";
import { useTranslation } from "../i18n";

export function TodayCodexUsageCard() {
  const rateLimit = useStore((s) => s.rateLimit);
  const cacheInfo = useStore((s) => s.codexUsageCache);
  const plan = useStore((s) => s.codexPlan);
  const { t } = useTranslation();
  if (!rateLimit && !cacheInfo) {
    return null;
  }

  return (
    <ProviderUsageCard
      provider="codex"
      title={t("quota.codex")}
      windows={rateLimit?.windows ?? []}
      cacheInfo={cacheInfo}
      plan={plan}
      limitResets={rateLimit?.limitResets}
    />
  );
}
