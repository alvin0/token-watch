import type { DisplayCurrencyConfig } from "../shared/protocol";
import { formatCost } from "./format";
import { localeTag, translate, type AppLanguage } from "../shared/i18n";

export function formatModelCost(
  costUsd: number,
  unknownCostTurns: number,
  turns: number,
  currency?: DisplayCurrencyConfig,
  locale?: string,
): string {
  if (turns > 0 && unknownCostTurns >= turns) {
    return "—";
  }
  const cost = formatCost(costUsd, currency, locale);
  return unknownCostTurns > 0 ? `${cost}+` : cost;
}

export function modelCostTitle(
  costUsd: number,
  unknownCostTurns: number,
  turns: number,
  currency?: DisplayCurrencyConfig,
  language: AppLanguage = "en",
): string {
  if (turns > 0 && unknownCostTurns >= turns) {
    return translate(language, "models.costUnavailable");
  }
  const cost = formatCost(costUsd, currency, localeTag(language));
  return unknownCostTurns > 0
    ? translate(language, "models.costPartial", { cost, turns: unknownCostTurns })
    : translate(language, "models.costTotal", { cost });
}
