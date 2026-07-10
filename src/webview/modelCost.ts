import type { DisplayCurrencyConfig } from "../shared/protocol";
import { formatCost } from "./format";

export function formatModelCost(costUsd: number, unknownCostTurns: number, turns: number): string {
  if (turns > 0 && unknownCostTurns >= turns) {
    return "—";
  }
  const cost = formatCost(costUsd);
  return unknownCostTurns > 0 ? `${cost}+` : cost;
}

export function modelCostTitle(
  costUsd: number,
  unknownCostTurns: number,
  turns: number,
  currency?: DisplayCurrencyConfig,
): string {
  if (turns > 0 && unknownCostTurns >= turns) {
    return "Cost unavailable: pricing is unknown for this model";
  }
  const cost = formatCost(costUsd, currency);
  return unknownCostTurns > 0
    ? `${cost} priced; ${unknownCostTurns} turn${unknownCostTurns === 1 ? "" : "s"} have unknown pricing`
    : `${cost} total cost`;
}
