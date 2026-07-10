/**
 * Variant identity helpers (Req 3.1, 7.1, 7.2).
 *
 * A "model variant" is a base model combined with its reasoning-effort level.
 * `makeVariantId` and `baseModelOf` are pure inverses for the labeled case and
 * the identity for the no-effort case (exercised by a round-trip property test).
 *
 * This module MUST NOT import `vscode`.
 */

import { Effort } from "./types";

export function makeVariantId(model: string, effort?: Effort): string {
  return effort && effort !== "n/a" ? `${model} (${effort})` : model;
}

export function baseModelOf(variantId: string): string {
  const m = variantId.match(/^(.*) \((minimal|low|medium|high|xhigh|ultra|max)\)$/);
  return m ? m[1] : variantId;
}

export function effortOf(variantId: string): Effort | undefined {
  const match = variantId.match(/\((minimal|low|medium|high|xhigh|ultra|max)\)$/);
  return match?.[1] as Effort | undefined;
}
