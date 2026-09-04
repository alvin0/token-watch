import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageCacheInfo } from "../../shared/protocol";
import { randomUsageRetryMs, rateLimitBackoffMs } from "../../shared/usageRetry";
import { fileIdentityOf, writeFileAtomicSync, type FileIdentity } from "../atomicFile";
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http";

export const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";
export const WHAM_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const WHAM_ENVIRONMENTS_ENDPOINT = "https://chatgpt.com/backend-api/wham/environments";
export const WHAM_LIMIT_RESETS_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const WHAM_LIMIT_RESET_CONSUME_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
export const DEFAULT_CODEX_ISSUER = "https://auth.openai.com";
export const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_SAFETY_MARGIN_MS = 30_000;
const DEFAULT_FAILURE_RETRY_MS = 60 * 1000;

const DEFAULT_ORIGINATOR = "opencode";
const DEFAULT_USER_AGENT = "codex-standalone-client";
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

export interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodexAuthSnapshot {
  path: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  expiresAt?: number;
  /** Identity of the auth file when it was read, for the write-back guard. */
  identity?: FileIdentity;
}

export interface CodexConnectionOptions {
  authFile?: string;
  endpoint?: string;
  fetch?: typeof fetch;
  issuer?: string;
  clientId?: string;
  originator?: string;
  userAgent?: string;
  now?: () => number;
  usageCacheTtlMs?: number;
  random?: () => number;
  /** Per-request deadline; a hung socket must not pin the refresh forever. */
  timeoutMs?: number;
}

export interface CodexRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  force?: boolean;
}

/** A request that is not a plain GET. Internal: only the consume call needs it. */
interface CodexWriteOptions extends CodexRequestOptions {
  method: string;
  body: string;
}

export class CodexUsageRateLimitError extends Error {
  constructor(
    public readonly retryAt: number,
    public readonly fromCooldown: boolean,
  ) {
    super(`Codex usage is rate limited until ${new Date(retryAt).toISOString()}`);
    this.name = "CodexUsageRateLimitError";
  }
}

export function isCodexUsageRateLimitError(error: unknown): error is CodexUsageRateLimitError {
  return error instanceof CodexUsageRateLimitError;
}

export class CodexConnection {
  private refreshPromise?: Promise<CodexAuthSnapshot>;

  constructor(private readonly options: CodexConnectionOptions = {}) {}

  async usage(options?: CodexRequestOptions): Promise<Response> {
    return this.requestWithRefresh(this.options.endpoint ?? WHAM_USAGE_ENDPOINT, options);
  }

  async environments(options?: CodexRequestOptions): Promise<Response> {
    return this.requestWithRefresh(WHAM_ENVIRONMENTS_ENDPOINT, options);
  }

  usageInfo<T = unknown>(options: CodexRequestOptions = {}): Promise<T> {
    return this.cachedGet<T>(this.options.endpoint ?? WHAM_USAGE_ENDPOINT, options);
  }

  /** Usage limit resets granted to the account, each with its own expiry. */
  limitResetsInfo<T = unknown>(options: CodexRequestOptions = {}): Promise<T> {
    return this.cachedGet<T>(WHAM_LIMIT_RESETS_ENDPOINT, options);
  }

  /**
   * Spend one usage limit reset on the account.
   *
   * Never cached and never coalesced with anything: it changes state upstream,
   * and a reset spent twice is a reset gone. `redeem_request_id` is built once
   * and reused if the call has to be replayed after a token refresh, so that
   * replay cannot cost a second reset.
   */
  async consumeLimitReset(creditId: string, options: CodexRequestOptions = {}): Promise<void> {
    const body = JSON.stringify({ credit_id: creditId, redeem_request_id: randomUUID() });
    const response = await this.requestWithRefresh(WHAM_LIMIT_RESET_CONSUME_ENDPOINT, {
      ...options,
      method: "POST",
      body,
      headers: { ...headersToRecord(options.headers), "content-type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Codex usage limit reset activation failed: ${response.status} ${await response.text()}`);
    }
    // The cached usage and reset list both describe the account as it was
    // before this call. Left in place, the card would keep offering a reset
    // that is already spent.
    usageInfoCache.delete(requestKey(this.options, this.options.endpoint ?? WHAM_USAGE_ENDPOINT));
    usageInfoCache.delete(requestKey(this.options, WHAM_LIMIT_RESETS_ENDPOINT));
  }

  private cachedGet<T>(url: string, options: CodexRequestOptions): Promise<T> {
    const key = requestKey(this.options, url);
    const now = (this.options.now ?? Date.now)();
    const cached = usageInfoCache.get(key);
    if (!options.force && cached && cached.expiresAt > now) {
      return Promise.resolve(cached.value as T);
    }

    const retryAt = usageCooldowns.get(key) ?? 0;
    if (retryAt > now) {
      if (cached) {
        return Promise.resolve(cached.value as T);
      }
      return Promise.reject(new CodexUsageRateLimitError(retryAt, true));
    }

    const inFlight = usageInfoPromises.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const promise = this.fetchJson<T>(url, key, options)
      .catch((error: unknown) => {
        if (!isCodexUsageRateLimitError(error)) {
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

  usageCacheInfo(): UsageCacheInfo {
    const key = requestKey(this.options, this.options.endpoint ?? WHAM_USAGE_ENDPOINT);
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

  private async fetchJson<T>(url: string, key: string, options: CodexRequestOptions): Promise<T> {
    const response = await this.requestWithRefresh(url, options);
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
      throw new CodexUsageRateLimitError(retryAt, false);
    }
    if (!response.ok) {
      throw new Error(`Codex request to ${url} failed: ${response.status} ${await response.text()}`);
    }
    usageCooldowns.delete(key);
    // A good response ends the run of refusals, so the next one starts short.
    usageRefusals.delete(key);
    const value = (await response.json()) as T;
    const now = (this.options.now ?? Date.now)();
    usageInfoCache.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + (this.options.usageCacheTtlMs ?? randomUsageRetryMs("codex", this.options.random)),
    });
    return value;
  }

  async environmentsInfo<T = unknown>(options?: CodexRequestOptions): Promise<T> {
    const response = await this.environments(options);
    if (!response.ok) {
      throw new Error(`Codex environments request failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async requestWithRefresh(url: string, options?: CodexRequestOptions | CodexWriteOptions): Promise<Response> {
    let auth = await readCodexAuthSnapshot(this.options.authFile);
    if (isTokenExpiringSoon(auth.expiresAt)) {
      auth = await this.refreshAuth(auth);
    }

    const response = await this.fetchWithAuth(url, auth, options);
    if (!(await shouldRefreshAfterResponse(response))) {return response;}

    auth = await this.refreshAuth(auth);
    return this.fetchWithAuth(url, auth, options);
  }

  private async fetchWithAuth(url: string, auth: CodexAuthSnapshot, options?: CodexRequestOptions | CodexWriteOptions) {
    const write = options && "method" in options ? options : undefined;
    return fetchWithTimeout(this.options.fetch ?? fetch, url, {
      method: write?.method ?? "GET",
      headers: buildUsageHeaders(auth, options?.headers, this.options),
      ...(write ? { body: write.body } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      timeoutMs: this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  private async refreshAuth(current: CodexAuthSnapshot) {
    if (this.refreshPromise) {return this.refreshPromise;}

    this.refreshPromise = refreshCodexAuthSnapshot(current, this.options)
      .finally(() => {
        this.refreshPromise = undefined;
      });

    return this.refreshPromise;
  }
}

export async function readCodexAuthSnapshot(authFile = DEFAULT_CODEX_AUTH_FILE): Promise<CodexAuthSnapshot> {
  const resolved = resolveCodexAuthPath(authFile);
  // Captured before the read so a rotation by Codex itself is detected when we
  // come to write the refreshed tokens back.
  const identity = fileIdentityOf(resolved);
  const auth = await readCodexAuthFile(resolved);
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
    throw new Error(`Unsupported Codex auth_mode "${auth.auth_mode}" at ${resolved}`);
  }
  const accessToken = cleanToken(auth.tokens?.access_token);
  const refreshToken = cleanToken(auth.tokens?.refresh_token);
  const accountId = cleanToken(auth.tokens?.account_id);
  const expiresAt = accessTokenExpiresAt(accessToken);

  if (!accessToken) {throw new Error(`Codex auth file ${resolved} is missing access_token`);}
  if (!refreshToken) {throw new Error(`Codex auth file ${resolved} is missing refresh_token`);}

  return {
    path: resolved,
    accessToken,
    refreshToken,
    ...(accountId ? { accountId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(identity ? { identity } : {}),
  };
}

export async function readCodexAuthMode(authFile = DEFAULT_CODEX_AUTH_FILE): Promise<string | undefined> {
  const resolved = resolveCodexAuthPath(authFile);
  const auth = await readCodexAuthFile(resolved);
  return typeof auth.auth_mode === "string" ? auth.auth_mode : undefined;
}

/** ChatGPT plan of the signed-in account, read from the `id_token` claims. */
export async function readCodexPlanType(authFile = DEFAULT_CODEX_AUTH_FILE): Promise<string | undefined> {
  const resolved = resolveCodexAuthPath(authFile);
  const auth = await readCodexAuthFile(resolved);
  const idToken = typeof auth.tokens?.id_token === "string" ? auth.tokens.id_token : undefined;
  return idToken ? extractPlanType(idToken) : undefined;
}

export function resolveCodexAuthPath(authFile = DEFAULT_CODEX_AUTH_FILE) {
  if (authFile === "~") {return os.homedir();}
  if (authFile.startsWith("~/") || authFile.startsWith("~\\")) {
    return path.join(os.homedir(), authFile.slice(2));
  }
  return path.isAbsolute(authFile) ? authFile : path.resolve(authFile);
}

function requestKey(options: CodexConnectionOptions, url: string): string {
  return `codex:${resolveCodexAuthPath(options.authFile)}:${url}`;
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

async function readCodexAuthFile(resolvedPath: string): Promise<CodexAuthFile> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read Codex auth file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unsupported Codex auth file at ${resolvedPath}`);
  }

  const auth = parsed as CodexAuthFile;
  return auth;
}

async function refreshCodexAuthSnapshot(
  current: CodexAuthSnapshot,
  options?: Pick<CodexConnectionOptions, "fetch" | "issuer" | "clientId" | "timeoutMs">,
) {
  const authFile = await readCodexAuthFile(current.path);
  if (authFile.auth_mode && authFile.auth_mode !== "chatgpt") {
    throw new Error(`Unsupported Codex auth_mode "${authFile.auth_mode}" at ${current.path}`);
  }
  const response = await fetchWithTimeout(
    options?.fetch ?? fetch,
    `${options?.issuer ?? DEFAULT_CODEX_ISSUER}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: options?.clientId ?? DEFAULT_CODEX_CLIENT_ID,
      }).toString(),
      timeoutMs: options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    },
  );

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
  }

  const tokens = validateCodexTokenResponse(await response.json().catch(() => undefined));
  const nextAccessToken = cleanToken(tokens?.access_token);
  const nextRefreshToken = cleanToken(tokens?.refresh_token) || current.refreshToken;
  if (!nextAccessToken || !nextRefreshToken) {
    throw new Error("Token refresh response is missing access_token or refresh_token");
  }

  const nextAccountId = cleanToken(tokens?.id_token ? extractAccountId(tokens.id_token) : undefined)
    || current.accountId
    || cleanToken(authFile.tokens?.account_id);
  const nextExpiresAt = tokens?.expires_in ? Date.now() + tokens.expires_in * 1000 : accessTokenExpiresAt(nextAccessToken);

  const nextAuth: CodexAuthFile = {
    ...authFile,
    tokens: {
      ...(authFile.tokens ?? {}),
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
      ...(nextAccountId ? { account_id: nextAccountId } : {}),
    },
  };

  // A failed write is NOT swallowed: the returned snapshot would then carry a
  // token pair that is not on disk, and the next process to read the file would
  // present the already-rotated refresh token and be signed out.
  const identity = writeCodexAuthFile(current.path, nextAuth, current.identity);

  return {
    path: current.path,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    ...(nextAccountId ? { accountId: nextAccountId } : {}),
    ...(nextExpiresAt ? { expiresAt: nextExpiresAt } : {}),
    identity,
  } satisfies CodexAuthSnapshot;
}

function writeCodexAuthFile(path: string, auth: CodexAuthFile, expectedIdentity?: FileIdentity): FileIdentity {
  return writeFileAtomicSync(path, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
    ...(expectedIdentity ? { expectedIdentity } : {}),
  });
}

/**
 * Shape-check the token endpoint's reply before trusting it.
 *
 * The response contract belongs to another product and can change without
 * notice; a silently-wrong shape here would be written straight into the user's
 * credentials file.
 */
function validateCodexTokenResponse(value: unknown): CodexTokenResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token", "id_token"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      throw new Error(`Token refresh response field "${key}" is not a string`);
    }
  }
  if (raw.expires_in !== undefined && (typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in))) {
    throw new Error('Token refresh response field "expires_in" is not a number');
  }
  return raw as unknown as CodexTokenResponse;
}

function buildUsageHeaders(
  auth: CodexAuthSnapshot,
  input?: HeadersInit,
  options?: Pick<CodexConnectionOptions, "originator" | "userAgent">,
) {
  const headers = new Headers(input);
  headers.set("authorization", `Bearer ${auth.accessToken}`);
  headers.set("accept", "application/json");
  headers.set("originator", options?.originator ?? DEFAULT_ORIGINATOR);
  headers.set("user-agent", options?.userAgent ?? DEFAULT_USER_AGENT);
  if (auth.accountId) {headers.set("ChatGPT-Account-Id", auth.accountId);}
  return headers;
}

/** Flatten a `HeadersInit` so a caller's headers survive being extended. */
function headersToRecord(input?: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(input).forEach((value, key) => { record[key] = value; });
  return record;
}

function cleanToken(value?: string) {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
}

function accessTokenExpiresAt(accessToken: string) {
  const payload = accessToken.split(".")[1];
  if (!payload) {return undefined;}
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function extractAccountId(token: string) {
  const claims = decodeTokenClaims(token);
  if (!claims) {return undefined;}
  return claims.chatgpt_account_id
    || claims["https://api.openai.com/auth"]?.chatgpt_account_id
    || claims.organizations?.[0]?.id;
}

function extractPlanType(token: string) {
  const claims = decodeTokenClaims(token);
  if (!claims) {return undefined;}
  return claims.chatgpt_plan_type || claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
}

interface CodexTokenClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

function decodeTokenClaims(token: string): CodexTokenClaims | undefined {
  const payload = token.split(".")[1];
  if (!payload) {return undefined;}
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as CodexTokenClaims;
  } catch {
    return undefined;
  }
}

async function shouldRefreshAfterResponse(response: Response) {
  if (response.status === 401 || response.status === 403) {return true;}
  if (response.ok) {return false;}
  const text = await response.clone().text().catch(() => "");
  return /expired|token expired|refresh token/i.test(text);
}

function isTokenExpiringSoon(expiresAt?: number) {
  return Boolean(expiresAt && expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now());
}

interface CodexTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
