import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageCacheInfo } from "../../shared/protocol";
import { randomUsageRetryMs } from "../../shared/usageRetry";

export const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";
export const WHAM_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const WHAM_ENVIRONMENTS_ENDPOINT = "https://chatgpt.com/backend-api/wham/environments";
export const WHAM_LIMIT_RESETS_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const DEFAULT_CODEX_ISSUER = "https://auth.openai.com";
export const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const REFRESH_SAFETY_MARGIN_MS = 30_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 60 * 1000;

const DEFAULT_ORIGINATOR = "opencode";
const DEFAULT_USER_AGENT = "codex-standalone-client";
const usageInfoPromises = new Map<string, Promise<unknown>>();
const usageCooldowns = new Map<string, number>();
const usageInfoCache = new Map<string, { value: unknown; cachedAt: number; expiresAt: number }>();

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
}

export interface CodexRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  force?: boolean;
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
      const retryAt = retryAtFromHeader(response.headers.get("retry-after"), now);
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
    const value = (await response.json()) as T;
    const now = (this.options.now ?? Date.now)();
    usageInfoCache.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + (this.options.usageCacheTtlMs ?? randomUsageRetryMs(this.options.random)),
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

  private async requestWithRefresh(url: string, options?: CodexRequestOptions): Promise<Response> {
    let auth = await readCodexAuthSnapshot(this.options.authFile);
    if (isTokenExpiringSoon(auth.expiresAt)) {
      auth = await this.refreshAuth(auth);
    }

    const response = await this.fetchWithAuth(url, auth, options);
    if (!(await shouldRefreshAfterResponse(response))) {return response;}

    auth = await this.refreshAuth(auth);
    return this.fetchWithAuth(url, auth, options);
  }

  private async fetchWithAuth(url: string, auth: CodexAuthSnapshot, options?: CodexRequestOptions) {
    return (this.options.fetch ?? fetch)(url, {
      method: "GET",
      headers: buildUsageHeaders(auth, options?.headers, this.options),
      signal: options?.signal,
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

function retryAtFromHeader(value: string | null, now: number): number {
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
  return now + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
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
  options?: Pick<CodexConnectionOptions, "fetch" | "issuer" | "clientId">,
) {
  const authFile = await readCodexAuthFile(current.path);
  if (authFile.auth_mode && authFile.auth_mode !== "chatgpt") {
    throw new Error(`Unsupported Codex auth_mode "${authFile.auth_mode}" at ${current.path}`);
  }
  const response = await (options?.fetch ?? fetch)(`${options?.issuer ?? DEFAULT_CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: options?.clientId ?? DEFAULT_CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
  }

  const tokens = await response.json().catch(() => undefined) as CodexTokenResponse | undefined;
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

  await writeCodexAuthFile(current.path, nextAuth).catch(() => undefined);

  return {
    path: current.path,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    ...(nextAccountId ? { accountId: nextAccountId } : {}),
    ...(nextExpiresAt ? { expiresAt: nextExpiresAt } : {}),
  } satisfies CodexAuthSnapshot;
}

async function writeCodexAuthFile(path: string, auth: CodexAuthFile) {
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`);
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
