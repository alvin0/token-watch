import type { DisplayCurrencyConfig } from "../shared/protocol.js";

const DEFAULT_LOCALE = "en-US";

/**
 * Format a USD cost value, optionally with the configured secondary currency.
 *
 * `currency` and `locale` are optional so pure/test callers can format a plain
 * USD string, but every UI call site should go through `useCostFormat()` — the
 * secondary currency was being sent to the store and then dropped by nearly
 * every card, and the numbers were grouped as en-US regardless of language.
 */
export function formatCost(
  usd: number,
  currency?: DisplayCurrencyConfig,
  locale: string = DEFAULT_LOCALE,
): string {
  const usdStr = `$${usd.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return withSecondary(usdStr, usd, currency, locale);
}

export function formatCostPerTurn(
  value: number,
  currency?: DisplayCurrencyConfig,
  locale: string = DEFAULT_LOCALE,
): string {
  if (!Number.isFinite(value) || value <= 0) { return "$0.00"; }
  const usdStr = `$${value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  })}`;
  return withSecondary(usdStr, value, currency, locale);
}

function withSecondary(
  usdStr: string,
  usd: number,
  currency: DisplayCurrencyConfig | undefined,
  locale: string,
): string {
  if (!currency?.secondary || !currency.secondaryRate || currency.secondaryRate <= 0) {
    return usdStr;
  }
  const secondary = usd * currency.secondaryRate;
  return `${usdStr} (${currency.secondary} ${secondary.toLocaleString(locale, { maximumFractionDigits: 0 })})`;
}
