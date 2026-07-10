import type { DisplayCurrencyConfig } from "../shared/protocol.js";

/**
 * Format a USD cost value with thousand separators.
 * e.g. 5911.61 → "$5,911.61", 134.72 → "$134.72"
 */
export function formatCost(usd: number, currency?: DisplayCurrencyConfig): string {
  const usdStr = `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency?.secondary && currency.secondaryRate && currency.secondaryRate > 0) {
    const secondary = usd * currency.secondaryRate;
    return `${usdStr} (${currency.secondary} ${secondary.toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
  }
  return usdStr;
}

export function formatCostPerTurn(value: number): string {
  if (!Number.isFinite(value) || value <= 0) { return "$0.00"; }
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  })}`;
}
