/**
 * One validator for every source of custom pricing.
 *
 * Pricing arrives from three places — the settings JSON, the JSONC file, and
 * the panel's dialog — and only the dialog checked its values. A rate of `-1`
 * from the other two produced negative costs, and `"oops"` produced NaN that
 * propagated through every total on the dashboard. Anything that cannot be
 * priced sanely is better dropped (or rejected) than shown as a number.
 *
 * This module MUST NOT import `vscode`.
 */

import type { ModelRate, PricingTable } from "./types.js";

/** The rate fields a model may define. */
export const RATE_FIELDS = ["inputPer1K", "cachedInputPer1K", "cacheCreationPer1K", "outputPer1K"] as const;

export type RateField = typeof RATE_FIELDS[number];

export interface PricingRejection {
  model: string;
  reason: string;
}

export interface ValidatedPricing {
  table: PricingTable;
  rejected: PricingRejection[];
}

/**
 * Validate one model's rates.
 *
 * Returns the cleaned rate, or a reason string when the entry is unusable.
 * Input and output rates are required — a model priced on only one side would
 * silently under-report cost.
 */
export function validateModelRate(rate: unknown, model: string): ModelRate | string {
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
    return `Pricing for "${model}" must be an object of per-1K rates.`;
  }
  const source = rate as Record<string, unknown>;
  const validated: ModelRate = {};

  for (const field of RATE_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) { continue; }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `"${model}.${field}" must be a number, got ${describe(value)}.`;
    }
    if (value < 0) {
      return `"${model}.${field}" must be 0 or greater, got ${value}.`;
    }
    validated[field] = value;
  }

  if (validated.inputPer1K === undefined || validated.outputPer1K === undefined) {
    return `"${model}" needs both inputPer1K and outputPer1K.`;
  }
  return validated;
}

/** True for a model id that may carry rates (`$`-prefixed keys are reserved). */
export function isValidModelId(model: string): boolean {
  return model.trim().length > 0 && !model.startsWith("$");
}

/**
 * Validate a whole table, dropping unusable entries.
 *
 * Used for pricing read from settings and from the JSONC file, where a single
 * bad entry must not throw away the rest — or take the extension down.
 */
export function validatePricingTable(raw: unknown): ValidatedPricing {
  const table: PricingTable = {};
  const rejected: PricingRejection[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { table, rejected };
  }

  for (const [rawModel, rawRate] of Object.entries(raw as Record<string, unknown>)) {
    const model = rawModel.trim();
    if (model === "$fallback") {
      // Documented as configurable but deliberately ignored by the merge; say
      // so rather than accepting it and quietly doing nothing.
      rejected.push({ model, reason: "$fallback is not configurable; bundled fallback pricing is always used." });
      continue;
    }
    if (!isValidModelId(model)) {
      rejected.push({ model: rawModel, reason: `"${rawModel}" is not a valid model id.` });
      continue;
    }
    const result = validateModelRate(rawRate, model);
    if (typeof result === "string") {
      rejected.push({ model, reason: result });
      continue;
    }
    table[model] = result;
  }

  return { table, rejected };
}

/**
 * Validate a table, throwing on the first problem.
 *
 * Used where a person is editing values and expects to be told what is wrong,
 * rather than having the bad row disappear.
 */
export function validatePricingTableStrict(raw: unknown): PricingTable {
  const { table, rejected } = validatePricingTable(raw);
  if (rejected.length > 0) {
    throw new Error(rejected[0].reason);
  }
  return table;
}

function describe(value: unknown): string {
  if (typeof value === "string") { return `the string ${JSON.stringify(value)}`; }
  if (value === null) { return "null"; }
  return `a ${typeof value}`;
}
