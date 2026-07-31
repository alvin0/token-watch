import { readClaudeSubscriptionType } from "../provider/claude";
import { DEFAULT_CODEX_AUTH_FILE, readCodexPlanType } from "../provider/codex";
import { claudePlanInfo } from "../shared/claudeUsage";
import { codexPlanInfo } from "../shared/codexUsage";
import type { UsagePlanInfo } from "../shared/protocol";

/**
 * Account plan lookups for the usage cards and the status bar tooltip. Plans come from
 * local credentials, so they stay available when a usage request fails; a failed lookup
 * keeps `previous` because the plan is informational only.
 */
export async function resolveCodexPlan(
  planType: string | undefined,
  previous?: UsagePlanInfo,
): Promise<UsagePlanInfo | undefined> {
  const fromUsage = codexPlanInfo(planType);
  if (fromUsage) {
    return fromUsage;
  }
  try {
    return codexPlanInfo(await readCodexPlanType(DEFAULT_CODEX_AUTH_FILE)) ?? previous;
  } catch {
    return previous;
  }
}

export async function resolveClaudePlan(previous?: UsagePlanInfo): Promise<UsagePlanInfo | undefined> {
  try {
    return claudePlanInfo(await readClaudeSubscriptionType()) ?? previous;
  } catch {
    return previous;
  }
}
