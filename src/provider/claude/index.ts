import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { UsageCacheInfo } from "../../shared/protocol";
import { randomUsageRetryMs, rateLimitBackoffMs } from "../../shared/usageRetry";
import { ConcurrentCredentialWriteError, fileIdentityOf, writeFileAtomicSync, type FileIdentity } from "../atomicFile";
import { withCredentialRefreshLock, type RefreshLockOptions } from "../credentialRefreshLock";
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http";
import { LimitResetNotSpentError } from "../limitReset";

export const DEFAULT_CLAUDE_CREDENTIALS_FILE = "~/.claude/.credentials.json";
export const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
/** `cedar_ember=1` asks for the usage limit resets block; `skip_spend=1` drops spend we never read. */
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
export const CLAUDE_ORGANIZATIONS_ENDPOINT = "https://api.anthropic.com/api/organizations";
/** Who the token belongs to, including the organization resets are claimed against. */
export const CLAUDE_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
/** The reset program Claude Code claims from, sent on every claim. */
const CLAUDE_LIMIT_RESET_PROGRAM = "cedar_ember";
/**
 * Claude Code's own deadline for a claim. Longer than a quota read: giving up
 * early on a claim the server goes on to apply leaves the user believing the
 * reset is still there.
 */
const CLAUDE_LIMIT_RESET_TIMEOUT_MS = 25_000;
/**
 * The Claude Code version presented when no newer one is installed.
 *
 * The usage limit resets block is only answered for Anthropic's own surfaces:
 * under any other user agent the account reads as `ineligible_reason:
 * "surface"` and no grants come back. So the usage read and the reset claim
 * both go out as Claude Code CLI. The server also checks the CLI version
 * (`cli_version`), so the installed one is preferred when it is newer.
 */
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.318";
/** Where Claude Code's native installer keeps one directory per installed version. */
const CLAUDE_NATIVE_VERSIONS_DIR = "~/.local/share/claude/versions";
/**
 * How long a token must sit expired before this process refreshes it itself.
 *
 * Claude Code CLI refreshes the same credentials whenever it is actually in
 * use, rotating the refresh_token in the process. Refreshing here on our own
 * schedule (e.g. shortly before expiry) races that: whichever side presents
 * the refresh_token second gets `invalid_grant` and is signed out. Waiting
 * out a stale grace period first lets an active CLI session refresh on its
 * own — this only steps in once it is clear nothing else is keeping the
 * token current (CLI idle or not running).
 */
const STALE_REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 60 * 1000;
const execFileAsync = promisify(execFile);
/** Bound for `security`; it can block on a Keychain prompt indefinitely. */
const KEYCHAIN_TIMEOUT_MS = 10_000;
const refreshPromises = new Map<string, Promise<ClaudeAuthSnapshot>>();
const usageInfoPromises = new Map<string, Promise<unknown>>();
const usageCooldowns = new Map<string, number>();
const usageInfoCache = new Map<string, { value: unknown; cachedAt: number; expiresAt: number }>();
/**
 * Refusals in a row, per endpoint, so the wait can widen.
 *
 * Cleared as soon as a call succeeds: the next refusal after a good response
 * is a blip, not a pattern, and should not inherit the last one's wait.
 */
const usageRefusals = new Map<string, number>();

interface ClaudeAiOauthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  subscriptionType?: string;
  [key: string]: unknown;
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeAiOauthCredentials;
  [key: string]: unknown;
}

export interface ClaudeAuthSnapshot {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  credentials: ClaudeCredentials;
  storage: "file" | "keychain";
  path?: string;
  /** Identity of the credentials file when it was read, for the write-back guard. */
  identity?: FileIdentity;
  /** Exact Keychain blob as read, for the same guard where there is no file identity. */
  storedValue?: string;
}

export interface ClaudeConnectionOptions {
  credentialsFile?: string;
  fetch?: typeof fetch;
  usageEndpoint?: string;
  tokenEndpoint?: string;
  /** Overridable for tests; where installed Claude Code versions are looked up. */
  cliVersionsDir?: string;
  /**
   * Claude Code versions known some other way — the Claude Code VS Code
   * extension carries its own CLI, at its own version, outside the native
   * installer's directory.
   */
  cliVersionHints?: () => Array<string | undefined>;
  clientId?: string;
  platform?: NodeJS.Platform;
  keychainService?: string;
  now?: () => number;
  usageCacheTtlMs?: number;
  random?: () => number;
  /** Per-request deadline; a hung socket must not pin the refresh forever. */
  timeoutMs?: number;
  /** Overridable for tests; the machine-wide single-flight guard for refreshes. */
  refreshLock?: RefreshLockOptions;
}

export interface ClaudeUsageRequestOptions {
  force?: boolean;
}

export class ClaudeUsageRateLimitError extends Error {
  constructor(
    public readonly retryAt: number,
    public readonly fromCooldown: boolean,
  ) {
    super(`Claude usage is rate limited until ${new Date(retryAt).toISOString()}`);
    this.name = "ClaudeUsageRateLimitError";
  }
}

export function isClaudeUsageRateLimitError(error: unknown): error is ClaudeUsageRateLimitError {
  return error instanceof ClaudeUsageRateLimitError;
}

/**
 * The token endpoint refused the refresh.
 *
 * Carries the status and body so the caller can tell a rotated-away grant
 * (`invalid_grant`, recoverable by re-reading what the CLI wrote) from a
 * genuine outage.
 */
export class ClaudeTokenRefreshError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Claude token refresh failed: ${status} ${body}`);
    this.name = "ClaudeTokenRefreshError";
  }

  /**
   * Whether the grant itself was rejected, rather than the service failing.
   *
   * Anthropic's refresh tokens are single-use and rotate with no overlap
   * window, so the usual cause is that Claude Code refreshed first and the
   * token we presented had already been spent.
   */
  get isInvalidGrant(): boolean {
    return (this.status === 400 || this.status === 401) && /invalid_grant/i.test(this.body);
  }
}

export class ClaudeConnection {
  constructor(private readonly options: ClaudeConnectionOptions = {}) {}

  async usage(): Promise<Response> {
    let auth = await readClaudeAuthSnapshot(this.options);
    if (isTokenStale(auth.expiresAt)) {
      auth = await this.refreshAuth(auth);
    }

    let response = await this.fetchUsage(auth);
    if (response.status !== 401 && response.status !== 403) {
      return response;
    }

    auth = await this.refreshAuth(auth);
    response = await this.fetchUsage(auth);
    return response;
  }

  usageInfo<T = unknown>(requestOptions: ClaudeUsageRequestOptions = {}): Promise<T> {
    const key = usageRequestKey(this.options);
    const now = (this.options.now ?? Date.now)();
    const cached = usageInfoCache.get(key);
    if (!requestOptions.force && cached && cached.expiresAt > now) {
      return Promise.resolve(cached.value as T);
    }

    const retryAt = usageCooldowns.get(key) ?? 0;
    if (retryAt > now) {
      if (cached) {
        return Promise.resolve(cached.value as T);
      }
      return Promise.reject(new ClaudeUsageRateLimitError(retryAt, true));
    }

    const inFlight = usageInfoPromises.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const promise = this.fetchUsageInfo<T>(key)
      .catch((error: unknown) => {
        if (!isClaudeUsageRateLimitError(error)) {
          setFailureCooldown(usageCooldowns, key, (this.options.now ?? Date.now)());
        }
        throw error;
      })
      .finally(() => {
        usageInfoPromises.delete(key);
      });
    usageInfoPromises.set(key, promise);
    return promise;
  }

  /**
   * Spend one usage limit reset from the given grant.
   *
   * Never cached and never coalesced: it changes state upstream. `request_id`
   * is built once and reused if the call has to be replayed after a token
   * refresh, so that replay cannot cost a second reset. Anything but a
   * `reset` result rejects with the server's own result and reason.
   */
  async consumeLimitReset(grantId: string): Promise<void> {
    let auth: ClaudeAuthSnapshot;
    let organizationUuid: string;
    try {
      auth = await readClaudeAuthSnapshot(this.options);
      if (isTokenStale(auth.expiresAt)) {
        auth = await this.refreshAuth(auth);
      }
      // Read with the very token the claim will carry, so the organization is
      // always the one that token belongs to — not whatever a config file on
      // disk last recorded, which can lag a sign-in or point at another
      // config directory.
      ({ auth, organizationUuid } = await this.readOrganization(auth));
    } catch (error) {
      throw new LimitResetNotSpentError(
        `Claude usage limit reset was not sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const body = JSON.stringify({ program: CLAUDE_LIMIT_RESET_PROGRAM, grant_id: grantId, request_id: randomUUID() });
    const url = `${CLAUDE_ORGANIZATIONS_ENDPOINT}/${encodeURIComponent(organizationUuid)}/reset_rate_limits`;
    // Once the claim is on the wire the cached usage may no longer describe the
    // account, however the call ends — a timeout included.
    usageInfoCache.delete(usageRequestKey(this.options));
    let response = await this.postLimitReset(url, body, auth);
    // Only 401 means the token. A 403 is the account being refused, and
    // refreshing for it would spend a refresh token Claude Code may need.
    if (response.status === 401) {
      try {
        auth = await this.refreshAuth(auth);
      } catch (error) {
        throw new LimitResetNotSpentError(
          `Claude usage limit reset was not sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      response = await this.postLimitReset(url, body, auth);
    }

    if (!response.ok) {
      const message = `Claude usage limit reset activation failed: ${response.status} ${await response.text()}`;
      // A 4xx is the server refusing the claim; a 5xx may have come after it applied it.
      throw response.status < 500 ? new LimitResetNotSpentError(message) : new Error(message);
    }

    const outcome = (await response.json().catch(() => undefined)) as { result?: unknown; reason?: unknown } | undefined;
    if (outcome?.result === "reset") {
      return;
    }
    if (typeof outcome?.result !== "string") {
      throw new Error("Claude answered the usage limit reset with something unreadable; it may have been applied.");
    }
    const reason = typeof outcome.reason === "string" ? ` (${outcome.reason})` : "";
    throw new LimitResetNotSpentError(`Claude did not apply the usage limit reset: ${outcome.result}${reason}`);
  }

  /** The organization the token belongs to, refreshing the token once if it is refused. */
  private async readOrganization(auth: ClaudeAuthSnapshot): Promise<{ auth: ClaudeAuthSnapshot; organizationUuid: string }> {
    let current = auth;
    let response = await this.fetchProfile(current);
    if (response.status === 401) {
      current = await this.refreshAuth(current);
      response = await this.fetchProfile(current);
    }
    if (!response.ok) {
      throw new Error(`Claude profile request failed: ${response.status} ${await response.text()}`);
    }
    const profile = (await response.json().catch(() => undefined)) as { organization?: { uuid?: unknown } } | undefined;
    const uuid = typeof profile?.organization?.uuid === "string" ? profile.organization.uuid.trim() : "";
    if (!uuid) {
      throw new Error("the Claude account is not in an organization; sign in to Claude Code first");
    }
    return { auth: current, organizationUuid: uuid };
  }

  usageCacheInfo(): UsageCacheInfo {
    const key = usageRequestKey(this.options);
    const now = (this.options.now ?? Date.now)();
    const cached = usageInfoCache.get(key);
    const cooldown = usageCooldowns.get(key) ?? 0;
    return {
      ...(cached ? { cachedAtUtc: cached.cachedAt } : {}),
      ...(cooldown > now
        ? { retryAtUtc: cooldown, retryPending: true }
        : cached && cached.expiresAt > now
          ? { retryAtUtc: cached.expiresAt }
          : {}),
    };
  }

  private async fetchUsageInfo<T>(key: string): Promise<T> {
    const response = await this.usage();
    if (response.status === 429) {
      const now = (this.options.now ?? Date.now)();
      const refusals = (usageRefusals.get(key) ?? 0) + 1;
      usageRefusals.set(key, refusals);
      const retryAt = retryAtFromHeader(response.headers.get("retry-after"), now, refusals);
      usageCooldowns.set(key, retryAt);
      const cached = usageInfoCache.get(key);
      if (cached) {
        return cached.value as T;
      }
      throw new ClaudeUsageRateLimitError(retryAt, false);
    }
    if (!response.ok) {
      throw new Error(`Claude usage request failed: ${response.status} ${await response.text()}`);
    }
    usageCooldowns.delete(key);
    // A good response ends the run of refusals, so the next one starts short.
    usageRefusals.delete(key);
    const value = (await response.json()) as T;
    const now = (this.options.now ?? Date.now)();
    usageInfoCache.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + (this.options.usageCacheTtlMs ?? randomUsageRetryMs("claude", this.options.random)),
    });
    return value;
  }

  private async fetchUsage(auth: ClaudeAuthSnapshot) {
    return fetchWithTimeout(this.options.fetch ?? fetch, this.options.usageEndpoint ?? CLAUDE_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        ...(await claudeCliHeaders(this.options)),
      },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  /** Not gated by surface, so it goes out under this extension's own name. */
  private fetchProfile(auth: ClaudeAuthSnapshot) {
    return fetchWithTimeout(this.options.fetch ?? fetch, CLAUDE_PROFILE_ENDPOINT, {
      method: "GET",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "user-agent": "token-watch",
      },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  private async postLimitReset(url: string, body: string, auth: ClaudeAuthSnapshot) {
    return fetchWithTimeout(this.options.fetch ?? fetch, url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        ...(await claudeCliHeaders(this.options)),
      },
      body,
      timeoutMs: this.options.timeoutMs ?? CLAUDE_LIMIT_RESET_TIMEOUT_MS,
    });
  }

  private async refreshAuth(current: ClaudeAuthSnapshot) {
    const key = credentialStorageKey(this.options);
    const inFlight = refreshPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.refreshAuthOnce(current)
      .finally(() => {
        refreshPromises.delete(key);
      });
    refreshPromises.set(key, promise);
    return promise;
  }

  /**
   * Refresh, but only if Claude Code has not already done it for us.
   *
   * The snapshot handed in was read before the request that failed, which can
   * be seconds old — long enough for Claude Code to have rotated the tokens in
   * the meantime. Presenting the superseded refresh token would earn an
   * `invalid_grant` here and, worse, spend a grant the CLI still expects to
   * own. So the credentials are read again at the last possible moment, and a
   * refusal is checked against the store once more before it is reported.
   */
  private async refreshAuthOnce(current: ClaudeAuthSnapshot): Promise<ClaudeAuthSnapshot> {
    const latest = await this.rereadAuth(current);
    if (supersedes(latest, current) && !isTokenStale(latest?.expiresAt)) {
      // Claude Code refreshed while we were queued; its tokens are the live
      // ones and ours would be rejected.
      return latest;
    }

    const base = latest ?? current;
    // Every VS Code window runs its own extension host, so the in-process map
    // above does not stop two of them refreshing the same account at once.
    const outcome = await withCredentialRefreshLock(
      credentialStorageKey(this.options),
      () => this.performRefresh(base),
      this.options.refreshLock,
    );
    if (outcome.ran) {
      return outcome.value;
    }

    // Another window is refreshing this very account. Spending a second grant
    // would invalidate whichever one it ends up not writing; take its result.
    const written = await this.rereadAuth(base);
    return supersedes(written, base) ? written : base;
  }

  private async performRefresh(base: ClaudeAuthSnapshot): Promise<ClaudeAuthSnapshot> {
    try {
      return await refreshClaudeAuthSnapshot(base, this.options);
    } catch (error) {
      if (!isRotatedGrantError(error)) {
        throw error;
      }
      // The grant was spent between the read above and the request. Whoever
      // spent it wrote the replacement to the store; take that rather than
      // reporting the account as broken. Claude Code recovers the same way
      // (its own `tengu_oauth_401_recovered_from_disk` path).
      const rotated = await this.rereadAuth(base);
      if (supersedes(rotated, base)) {
        return rotated;
      }
      throw error;
    }
  }

  /** Re-read the credential store, treating a read failure as "nothing newer". */
  private async rereadAuth(fallbackFor: ClaudeAuthSnapshot): Promise<ClaudeAuthSnapshot | undefined> {
    try {
      const snapshot = await readClaudeAuthSnapshot(this.options);
      return snapshot.storage === fallbackFor.storage ? snapshot : undefined;
    } catch {
      // A vanished or malformed store is the caller's problem to report, not a
      // reason to abandon the refresh we were asked for.
      return undefined;
    }
  }
}

export async function readClaudeAuthSnapshot(options: ClaudeConnectionOptions = {}): Promise<ClaudeAuthSnapshot> {
  const resolvedFile = resolveClaudeCredentialsPath(options.credentialsFile);
  const platform = options.platform ?? process.platform;

  if (platform === "darwin" && !options.credentialsFile) {
    const stored = await readKeychainPassword(options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE);
    if (stored !== undefined) {
      // The exact stored text is kept so the write-back can check the entry has
      // not been replaced meanwhile; a Keychain item has no inode or mtime to
      // pin the way a file does.
      return authSnapshot(parseCredentials(stored, "macOS Keychain"), "keychain", undefined, undefined, stored);
    }
    // Claude Code falls back to the credentials file when Keychain is unavailable.
  }

  // Captured before the read so a rotation by Claude Code itself is detected
  // when we come to write the refreshed tokens back.
  const identity = fileIdentityOf(resolvedFile);
  let raw: string;
  try {
    raw = await readFile(resolvedFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Claude credentials ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return authSnapshot(parseCredentials(raw, resolvedFile), "file", resolvedFile, identity);
}

export function resolveClaudeCredentialsPath(credentialsFile = DEFAULT_CLAUDE_CREDENTIALS_FILE): string {
  if (credentialsFile === "~") {
    return os.homedir();
  }
  if (credentialsFile.startsWith("~/") || credentialsFile.startsWith("~\\")) {
    return path.join(os.homedir(), credentialsFile.slice(2));
  }
  return path.isAbsolute(credentialsFile) ? credentialsFile : path.resolve(credentialsFile);
}

function parseCredentials(raw: string, source: string): ClaudeCredentials {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root value is not an object");
    }
    return parsed as ClaudeCredentials;
  } catch (error) {
    throw new Error(`Unsupported Claude credentials at ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read the stored credential blob, or undefined when the entry is unreadable. */
async function readKeychainPassword(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: KEYCHAIN_TIMEOUT_MS });
    return stdout;
  } catch {
    return undefined;
  }
}

function authSnapshot(
  credentials: ClaudeCredentials,
  storage: ClaudeAuthSnapshot["storage"],
  filePath?: string,
  identity?: FileIdentity,
  storedValue?: string,
): ClaudeAuthSnapshot {
  const oauth = credentials.claudeAiOauth;
  const accessToken = cleanToken(oauth?.accessToken);
  const refreshToken = cleanToken(oauth?.refreshToken);
  if (!accessToken) {
    throw new Error("Claude credentials are missing claudeAiOauth.accessToken");
  }
  if (!refreshToken) {
    throw new Error("Claude credentials are missing claudeAiOauth.refreshToken");
  }
  const subscriptionType = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType.trim() : "";
  return {
    accessToken,
    refreshToken,
    ...(isFiniteNumber(oauth?.expiresAt) ? { expiresAt: oauth.expiresAt } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    credentials,
    storage,
    ...(filePath ? { path: filePath } : {}),
    ...(identity ? { identity } : {}),
    ...(storedValue !== undefined ? { storedValue } : {}),
  };
}

/** Claude Code CLI's request identity, at the newest version installed here. */
async function claudeCliHeaders(options: ClaudeConnectionOptions): Promise<Record<string, string>> {
  const version = await installedClaudeCliVersion(options);
  return { "user-agent": `claude-cli/${version} (external, cli)`, "x-app": "cli" };
}

/**
 * The newest Claude Code version installed here — natively, or through a hint
 * such as the VS Code extension — or the fallback when that is older or
 * nothing is found.
 */
async function installedClaudeCliVersion(options: ClaudeConnectionOptions): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(resolveClaudeCredentialsPath(options.cliVersionsDir ?? CLAUDE_NATIVE_VERSIONS_DIR));
  } catch {
    // Not installed natively (npm, Homebrew, extension only, none at all).
  }
  for (const hint of options.cliVersionHints?.() ?? []) {
    if (typeof hint === "string") { names.push(hint.trim()); }
  }
  return names.reduce(
    (newest, name) => (/^\d+\.\d+\.\d+$/.test(name) && compareVersions(name, newest) > 0 ? name : newest),
    CLAUDE_CLI_FALLBACK_VERSION,
  );
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) { return left[index] - right[index]; }
  }
  return 0;
}

/** Subscription tier of the signed-in Claude account, read from the stored credentials. */
export async function readClaudeSubscriptionType(options: ClaudeConnectionOptions = {}): Promise<string | undefined> {
  return (await readClaudeAuthSnapshot(options)).subscriptionType;
}

async function refreshClaudeAuthSnapshot(
  current: ClaudeAuthSnapshot,
  options: ClaudeConnectionOptions,
): Promise<ClaudeAuthSnapshot> {
  const response = await fetchWithTimeout(
    options.fetch ?? fetch,
    options.tokenEndpoint ?? CLAUDE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
      }),
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    },
  );

  if (!response.ok) {
    throw new ClaudeTokenRefreshError(response.status, await response.text().catch(() => ""));
  }

  const tokens = validateClaudeTokenResponse(await response.json().catch(() => undefined));
  const accessToken = cleanToken(tokens?.access_token);
  const refreshToken = cleanToken(tokens?.refresh_token) || current.refreshToken;
  if (!accessToken) {
    throw new Error("Claude token refresh response is missing access_token");
  }

  const now = Date.now();
  const oauth = current.credentials.claudeAiOauth ?? {};
  const credentials: ClaudeCredentials = {
    ...current.credentials,
    claudeAiOauth: {
      ...oauth,
      accessToken,
      refreshToken,
      ...(isFiniteNumber(tokens?.expires_in) ? { expiresAt: now + tokens.expires_in * 1_000 } : {}),
      ...(isFiniteNumber(tokens?.refresh_token_expires_in)
        ? { refreshTokenExpiresAt: now + tokens.refresh_token_expires_in * 1_000 }
        : {}),
    },
  };

  const identity = await persistClaudeCredentials(current, credentials, options);
  return authSnapshot(credentials, current.storage, current.path, identity);
}

/**
 * Shape-check the token endpoint's reply before trusting it.
 *
 * The response contract belongs to another product and can change without
 * notice; a silently-wrong shape here would be written straight into the user's
 * credentials file.
 */
function validateClaudeTokenResponse(value: unknown): ClaudeTokenResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new Error(`Claude token refresh response field "${key}" is not a string`);
    }
  }
  for (const key of ["expires_in", "refresh_token_expires_in"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) {
      throw new Error(`Claude token refresh response field "${key}" is not a number`);
    }
  }
  return raw as unknown as ClaudeTokenResponse;
}

async function persistClaudeCredentials(
  current: ClaudeAuthSnapshot,
  credentials: ClaudeCredentials,
  options: ClaudeConnectionOptions,
): Promise<FileIdentity | undefined> {
  const serialized = JSON.stringify(credentials);
  if (current.storage === "keychain") {
    const service = options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
    // `security` has no compare-and-swap, so this is a check, not a lock: it
    // catches a rotation Claude Code has already committed rather than one
    // landing in the microseconds around the write.
    if (current.storedValue !== undefined) {
      const stored = await readKeychainPassword(service);
      if (stored !== undefined && stored.trim() !== current.storedValue.trim()) {
        throw new ConcurrentCredentialWriteError(`Keychain item "${service}"`);
      }
    }
    try {
      await writeKeychainPassword(
        options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE,
        serialized,
      );
    } catch {
      // Never propagate the underlying error: it can carry the command line,
      // and therefore the credential JSON, into logs.
      throw new Error(
        "Failed to update Claude credentials in the macOS Keychain. " +
        "Token Watch will not fall back to passing credentials on the command line, " +
        "so Claude quota may show as unavailable until Claude Code refreshes its own token.",
      );
    }
    return undefined;
  }

  if (!current.path) {
    throw new Error("Claude credentials file path is unavailable");
  }
  await mkdir(path.dirname(current.path), { recursive: true });
  return writeFileAtomicSync(current.path, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
    ...(current.identity ? { expectedIdentity: current.identity } : {}),
  });
}

/**
 * Store a password in the login Keychain, passing it on stdin.
 *
 * `security add-generic-password -w <value>` puts the secret in the process's
 * argv, where any user on the machine can read it out of `ps`. Omitting the
 * value asks `security` to read the password itself.
 *
 * There is deliberately NO argv fallback. If this mode is unavailable — Apple's
 * SecurityTool reads through the controlling terminal on some releases — the
 * refresh fails and the quota display goes unavailable. That is a visibly
 * degraded feature; putting an access and refresh token into a process's
 * command line, where any local process can read it, is a credential leak. The
 * caller treats the failure as "cannot refresh" and leaves the stored
 * credentials untouched, so the user's sign-in is never damaged either.
 */
function writeKeychainPassword(service: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", [
      "add-generic-password",
      "-U",
      "-a",
      os.userInfo().username,
      "-s",
      service,
      "-w",
    ], { stdio: ["pipe", "ignore", "ignore"] });

    const timer = setTimeout(() => {
      // A build that prompts on the terminal never reads our stdin; do not
      // leave it waiting.
      child.kill("SIGKILL");
      reject(new Error("security did not accept the password on stdin"));
    }, KEYCHAIN_TIMEOUT_MS);
    timer.unref?.();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); } else { reject(new Error(`security exited with code ${code}`)); }
    });

    child.stdin.on("error", () => { /* reported through the close/error handlers */ });
    child.stdin.end(`${password}\n`);
  });
}


function cleanToken(value?: string): string {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether the store now holds a different token pair from the one we hold. */
function supersedes(
  next: ClaudeAuthSnapshot | undefined,
  previous: ClaudeAuthSnapshot,
): next is ClaudeAuthSnapshot {
  return Boolean(next && (next.accessToken !== previous.accessToken || next.refreshToken !== previous.refreshToken));
}

function isRotatedGrantError(error: unknown): boolean {
  return error instanceof ClaudeTokenRefreshError && error.isInvalidGrant;
}

function isTokenStale(expiresAt?: number): boolean {
  return Boolean(expiresAt && Date.now() - expiresAt > STALE_REFRESH_THRESHOLD_MS);
}

function credentialStorageKey(options: ClaudeConnectionOptions): string {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && !options.credentialsFile) {
    return `keychain:${options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE}`;
  }
  return `file:${resolveClaudeCredentialsPath(options.credentialsFile)}`;
}

function usageRequestKey(options: ClaudeConnectionOptions): string {
  return `${credentialStorageKey(options)}:${options.usageEndpoint ?? CLAUDE_USAGE_ENDPOINT}`;
}

/**
 * When to try again after a refusal.
 *
 * `Retry-After` is honoured when the service sends one. Claude's usage
 * endpoint does not, so the wait has to be guessed; starting at the maximum,
 * as this used to, meant a single transient refusal cost a quarter of an hour
 * of stale figures.
 */
function retryAtFromHeader(value: string | null, now: number, refusals = 1): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + seconds * 1_000;
    }

    const date = Date.parse(value);
    if (Number.isFinite(date) && date > now) {
      return date;
    }
  }
  return now + rateLimitBackoffMs(refusals);
}

function setFailureCooldown(cooldowns: Map<string, number>, key: string, now: number): void {
  if ((cooldowns.get(key) ?? 0) <= now) {
    cooldowns.set(key, now + DEFAULT_FAILURE_RETRY_MS);
  }
}

interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}
