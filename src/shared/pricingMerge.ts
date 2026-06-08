import { DEFAULT_PRICING, FALLBACK_RATE } from "./defaultPricing.js";
import type { ModelRate, PricingTable } from "./types.js";

export interface PricingMergeAudit {
  ignoredKnownModelOverrides: string[];
  ignoredFallbackOverride: boolean;
  customModelOverrides: string[];
}

export interface MergedPricingConfig {
  table: PricingTable;
  fallbackRate: ModelRate;
  audit: PricingMergeAudit;
}

export function mergePricingConfig(overrides: PricingTable = {}): MergedPricingConfig {
  const custom: PricingTable = {};
  const ignoredKnownModelOverrides: string[] = [];
  let ignoredFallbackOverride = false;

  for (const [model, rate] of Object.entries(overrides)) {
    if (model === "$fallback") {
      ignoredFallbackOverride = true;
      continue;
    }
    if (model.startsWith("$")) {
      continue;
    }
    if (Object.hasOwn(DEFAULT_PRICING, model)) {
      ignoredKnownModelOverrides.push(model);
      continue;
    }
    custom[model] = rate;
  }

  return {
    table: { ...DEFAULT_PRICING, ...custom },
    fallbackRate: FALLBACK_RATE,
    audit: {
      ignoredKnownModelOverrides: ignoredKnownModelOverrides.sort(),
      ignoredFallbackOverride,
      customModelOverrides: Object.keys(custom).sort(),
    },
  };
}
