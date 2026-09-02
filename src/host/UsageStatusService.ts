import * as vscode from "vscode";
import { usageRetryBounds } from "../shared/usageRetry";
import { CodexConnection, DEFAULT_CODEX_AUTH_FILE, isCodexUsageRateLimitError, readCodexAuthMode } from "../provider/codex";
import { ClaudeConnection, isClaudeUsageRateLimitError } from "../provider/claude";
import { mapCodexUsageToRateLimitInfo, type CodexUsageResponse } from "../shared/codexUsage";
import { mapClaudeUsageToRateLimitInfo, type ClaudeUsageResponse } from "../shared/claudeUsage";
import { codexLimitResetsFetcher, withLimitResetDetails } from "./limitResets";
import { resolveClaudePlan, resolveCodexPlan } from "./usagePlan";
import { UsageRefreshTimer } from "./UsageRefreshTimer";
import type { LimitResetReminder } from "./LimitResetReminder";
import { providerRequestsEnabled } from "../shared/testMode";
import type {
  ClaudeRateLimitInfo,
  RateLimitInfo,
  UsageCacheInfo,
  UsagePlanInfo,
  UsageProvider,
} from "../shared/protocol";

/**
 * One owner of provider quota state for the whole extension.
 *
 * The sidebar and the status bar previously each carried their own copy of the
 * fetch / cache / retry / plan / limit-reset logic — two timers, two sets of
 * "am I refreshing" flags, two places to fix a bug. They are two views of the
 * same thing, so the state lives here and both subscribe.
 *
 * Refreshing is gated on demand: the service only runs timers while at least
 * one consumer says it is showing the numbers.
 */

/**
 * The floor between unforced refreshes, per provider.
 *
 * One five-minute figure for both was slower than either service asks for: it
 * held Codex figures back for five minutes when its own client refreshes every
 * sixty seconds. Each provider's own spacing is the right floor.
 */
function refreshFloorMs(provider: UsageProvider): number {
  return usageRetryBounds(provider).minMs;
}

/**
 * When the next refresh should run, given what the provider's cache reports.
 *
 * `retryAtUtc` carries two different things: when a cooldown lifts after a
 * refusal, and when a good response goes stale. Only the first used to be
 * scheduled, so a healthy provider was fetched once and then never again — the
 * figures sat frozen until someone pressed refresh or reopened the panel.
 *
 * Pure, and exported, because it is the rule that decides whether the numbers
 * stay live at all.
 */
export function nextRefreshAt(
  cache: UsageCacheInfo,
  provider: UsageProvider,
  now: number,
): number {
  if (typeof cache.retryAtUtc === "number" && Number.isFinite(cache.retryAtUtc)) {
    return cache.retryAtUtc;
  }
  // Nothing cached and no cooldown: the last attempt left us nothing to go on,
  // so try again once this provider's own spacing has passed.
  return now + refreshFloorMs(provider);
}

/**
 * The account lookups a refresh makes besides the quota call itself.
 *
 * They read the machine's real sign-in state — the Codex auth file, and on
 * macOS a `security find-generic-password` subprocess for Claude — so a test
 * that replaces the connections but not these still reads the developer's own
 * credentials, and waits on a subprocess to decide whether a call went out.
 * Injectable so a test can replace the lot.
 */
export interface UsageAccountLookups {
  codexAuthMode(): Promise<string | undefined>;
  codexPlan(planType: string | undefined, previous?: UsagePlanInfo): Promise<UsagePlanInfo | undefined>;
  claudePlan(previous?: UsagePlanInfo): Promise<UsagePlanInfo | undefined>;
}

/** What the service talks to. Everything defaults to the real thing. */
export interface UsageStatusDeps {
  codex?: CodexConnection;
  claude?: ClaudeConnection;
  accounts?: UsageAccountLookups;
}

const REAL_ACCOUNT_LOOKUPS: UsageAccountLookups = {
  codexAuthMode: () => readCodexAuthMode(DEFAULT_CODEX_AUTH_FILE),
  codexPlan: resolveCodexPlan,
  claudePlan: resolveClaudePlan,
};

export interface UsageStatusState {
  codexRateLimit?: RateLimitInfo;
  claudeRateLimit?: ClaudeRateLimitInfo;
  codexUsageCache?: UsageCacheInfo;
  claudeUsageCache?: UsageCacheInfo;
  codexPlan?: UsagePlanInfo;
  claudePlan?: UsagePlanInfo;
  /** True once a fetch has failed and nothing usable has ever been loaded. */
  codexUnavailable: boolean;
  claudeUnavailable: boolean;
}

export interface UsageRefreshOptions {
  /** Ignore the 5-minute floor between refreshes. */
  force?: boolean;
  /** Ignore the provider's response cache and hit the network. */
  bypassCache?: boolean;
}

interface ProviderRuntime {
  inFlight: Promise<void> | undefined;
  lastRefreshAt: number;
  timer: UsageRefreshTimer;
}

export class UsageStatusService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<UsageStatusState>();
  readonly onDidChange = this._onDidChange.event;

  private readonly codexConnection: CodexConnection;
  private readonly claudeConnection: ClaudeConnection;
  private readonly accounts: UsageAccountLookups;
  private readonly activeConsumers = new Set<string>();
  private state: UsageStatusState = { codexUnavailable: false, claudeUnavailable: false };
  private disposed = false;
  private readonly runtime: Record<UsageProvider, ProviderRuntime>;

  /**
   * `deps` exists so a test can watch what each provider is actually asked for.
   * Whether refreshing one provider drags the other along with it is the kind of
   * thing that is easy to assert about by reading and easy to get wrong, and
   * getting it wrong means a 429 on the service that tolerates the least
   * polling. Replacing the connections alone is not enough — see
   * `UsageAccountLookups`.
   */
  constructor(
    private readonly limitResetReminder?: LimitResetReminder,
    deps?: UsageStatusDeps,
  ) {
    this.codexConnection = deps?.codex
      ?? new CodexConnection({ authFile: DEFAULT_CODEX_AUTH_FILE });
    this.claudeConnection = deps?.claude ?? new ClaudeConnection();
    this.accounts = deps?.accounts ?? REAL_ACCOUNT_LOOKUPS;
    this.runtime = {
      codex: {
        inFlight: undefined,
        lastRefreshAt: 0,
        timer: new UsageRefreshTimer(() => { void this.refresh("codex", { force: true }); }),
      },
      claude: {
        inFlight: undefined,
        lastRefreshAt: 0,
        timer: new UsageRefreshTimer(() => { void this.refresh("claude", { force: true }); }),
      },
    };
  }

  getState(): UsageStatusState {
    return this.state;
  }

  /** Live cache info, for tooltips that want the values as of right now. */
  cacheInfo(provider: UsageProvider): UsageCacheInfo {
    return provider === "codex"
      ? this.codexConnection.usageCacheInfo()
      : this.claudeConnection.usageCacheInfo();
  }

  /**
   * Register whether a consumer is currently showing usage. Refreshing runs
   * only while at least one is; a hidden sidebar and a disabled status bar mean
   * no background network calls at all.
   */
  setConsumerActive(consumerId: string, active: boolean): void {
    const wasActive = this.isActive();
    if (active) {
      this.activeConsumers.add(consumerId);
    } else {
      this.activeConsumers.delete(consumerId);
    }
    if (!this.isActive()) {
      this.runtime.codex.timer.clear();
      this.runtime.claude.timer.clear();
      return;
    }
    if (!wasActive) {
      // Deliberately not forced. The first time round there is nothing cached
      // and both refresh anyway; after that, reopening the panel is not a reason
      // to ask a provider again inside its own spacing. Forcing here meant
      // toggling the sidebar could put several calls through to the service that
      // tolerates the least polling.
      void this.refresh("codex");
      void this.refresh("claude");
    }
  }

  isActive(): boolean {
    // Provider requests are authenticated calls that can rewrite the user's
    // credentials on a token refresh; the integration harness must never make
    // them against a real account.
    return !this.disposed && this.activeConsumers.size > 0 && providerRequestsEnabled();
  }

  refresh(provider: UsageProvider, options: UsageRefreshOptions = {}): Promise<void> {
    if (!this.isActive()) {
      return Promise.resolve();
    }
    const runtime = this.runtime[provider];
    if (runtime.inFlight) {
      return runtime.inFlight;
    }
    if (!options.force && Date.now() - runtime.lastRefreshAt < refreshFloorMs(provider)) {
      return Promise.resolve();
    }

    this.patch(provider === "codex"
      ? { codexUsageCache: { ...this.cacheInfo("codex"), refreshing: true, unavailable: !this.state.codexRateLimit } }
      : { claudeUsageCache: { ...this.cacheInfo("claude"), refreshing: true, unavailable: !this.state.claudeRateLimit } });

    const work = (provider === "codex"
      ? this.refreshCodex(options)
      : this.refreshClaude(options)
    ).finally(() => {
      runtime.lastRefreshAt = Date.now();
      runtime.inFlight = undefined;
      this.patch(provider === "codex"
        ? { codexUsageCache: { ...this.cacheInfo("codex"), refreshing: false, unavailable: !this.state.codexRateLimit } }
        : { claudeUsageCache: { ...this.cacheInfo("claude"), refreshing: false, unavailable: !this.state.claudeRateLimit } });
      this.scheduleNext(provider);
    });

    runtime.inFlight = work;
    return work;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.activeConsumers.clear();
    this.runtime.codex.timer.clear();
    this.runtime.claude.timer.clear();
    this._onDidChange.dispose();
  }

  // --- Private ---

  private async refreshCodex(options: UsageRefreshOptions): Promise<void> {
    try {
      const authMode = await this.accounts.codexAuthMode();
      if (authMode && authMode !== "chatgpt") {
        // API-key auth has no subscription quota to report.
        this.patch({ codexRateLimit: undefined, codexPlan: undefined, codexUnavailable: true });
        return;
      }

      const usage = await this.codexConnection.usageInfo<CodexUsageResponse>({ force: options.bypassCache });
      if (this.disposed) { return; }
      const rateLimit = mapCodexUsageToRateLimitInfo(usage);
      if (rateLimit) {
        rateLimit.limitResets = await withLimitResetDetails(
          codexLimitResetsFetcher(this.codexConnection),
          rateLimit.limitResets,
          options.bypassCache,
        );
      }
      const plan = await this.accounts.codexPlan(usage.plan_type, this.state.codexPlan);
      if (this.disposed) { return; }
      if (rateLimit) {
        void this.limitResetReminder?.evaluate(rateLimit.limitResets);
      }
      this.patch({
        codexPlan: plan,
        ...(rateLimit ? { codexRateLimit: rateLimit } : {}),
        codexUnavailable: !(rateLimit ?? this.state.codexRateLimit),
      });
    } catch (error) {
      if (this.disposed) { return; }
      if (!isCodexUsageRateLimitError(error)) {
        console.warn("[TokenWatch] Codex usage refresh failed:", error);
      }
      const plan = await this.accounts.codexPlan(undefined, this.state.codexPlan);
      this.patch({ codexPlan: plan, codexUnavailable: !this.state.codexRateLimit });
    }
  }

  private async refreshClaude(options: UsageRefreshOptions): Promise<void> {
    try {
      const plan = await this.accounts.claudePlan(this.state.claudePlan);
      const usage = await this.claudeConnection.usageInfo<ClaudeUsageResponse>({ force: options.bypassCache });
      if (this.disposed) { return; }
      const rateLimit = mapClaudeUsageToRateLimitInfo(usage);
      this.patch({
        claudePlan: plan,
        ...(rateLimit ? { claudeRateLimit: rateLimit } : {}),
        claudeUnavailable: !(rateLimit ?? this.state.claudeRateLimit),
      });
    } catch (error) {
      if (this.disposed) { return; }
      if (!isClaudeUsageRateLimitError(error)) {
        console.warn("[TokenWatch] Claude usage refresh failed:", error);
      }
      this.patch({ claudeUnavailable: !this.state.claudeRateLimit });
    }
  }

  /**
   * Line up the next refresh.
   *
   * `retryAtUtc` carries two different things: when a cooldown lifts after a
   * refusal, and when the cached response goes stale. Only the first used to be
   * scheduled, so a healthy provider was fetched once and then never again —
   * the figures sat frozen until someone pressed refresh or the panel was
   * reopened, which is the opposite of what a live view is for.
   */
  private scheduleNext(provider: UsageProvider): void {
    const runtime = this.runtime[provider];
    if (!this.isActive()) {
      runtime.timer.clear();
      return;
    }
    runtime.timer.schedule(nextRefreshAt(this.cacheInfo(provider), provider, Date.now()));
  }

  private patch(partial: Partial<UsageStatusState>): void {
    this.state = { ...this.state, ...partial };
    if (!this.disposed) {
      this._onDidChange.fire(this.state);
    }
  }
}
