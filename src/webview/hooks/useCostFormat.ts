import { useMemo } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { formatCost, formatCostPerTurn } from "../format";

export interface CostFormatter {
  cost: (usd: number) => string;
  perTurn: (usd: number) => string;
}

/**
 * Cost formatting bound to the configured secondary currency and the UI locale.
 *
 * Every card should format through this rather than calling `formatCost`
 * directly, so a configured secondary currency shows up everywhere instead of
 * only in the two places that happened to pass it.
 */
export function useCostFormat(): CostFormatter {
  const currency = useStore((state) => state.currency);
  const { locale } = useTranslation();
  return useMemo(() => ({
    cost: (usd: number) => formatCost(usd, currency, locale),
    perTurn: (usd: number) => formatCostPerTurn(usd, currency, locale),
  }), [currency, locale]);
}
