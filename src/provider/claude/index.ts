import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { UsageCacheInfo } from "../../shared/protocol";
import { randomUsageRetryMs } from "../../shared/usageRetry";

export const DEFAULT_CLAUDE_CREDENTIALS_FILE = "~/.claude/.credentials.json";
export const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const REFRESH_SAFETY_MARGIN_MS = 30_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_FAILURE_RETRY_MS = 60 * 1000;
const execFileAsync = promisify(execFile);
const refreshPromises = new Map<string, Promise<ClaudeAuthSnapshot>>();
const usageInfoPromises = new Map<string, Promise<unknown>>();
const usageCooldowns = new Map<string, number>();
const usageInfoCache = new Map<string, { value: unknown; cachedAt: number; expiresAt: number }>();

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
}

export interface ClaudeConnectionOptions {
  credentialsFile?: string;
  fetch?: typeof fetch;
  usageEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  platform?: NodeJS.Platform;
  keychainService?: string;
  now?: () => number;
  usageCacheTtlMs?: number;
  random?: () => number;
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

export class ClaudeConnection {
  constructor(private readonly options: ClaudeConnectionOptions = {}) {}

  async usage(): Promise<Response> {
    let auth = await readClaudeAuthSnapshot(this.options);
    if (isTokenExpiringSoon(auth.expiresAt)) {
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
      const retryAt = retryAtFromHeader(response.headers.get("retry-after"), now);
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
    const value = (await response.json()) as T;
    const now = (this.options.now ?? Date.now)();
    usageInfoCache.set(key, {
      value,
      cachedAt: now,
      expiresAt: now + (this.options.usageCacheTtlMs ?? randomUsageRetryMs(this.options.random)),
    });
    return value;
  }

  private fetchUsage(auth: ClaudeAuthSnapshot) {
    return (this.options.fetch ?? fetch)(this.options.usageEndpoint ?? CLAUDE_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "user-agent": "token-watch",
      },
    });
  }

  private async refreshAuth(current: ClaudeAuthSnapshot) {
    const key = credentialStorageKey(this.options);
    const inFlight = refreshPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = refreshClaudeAuthSnapshot(current, this.options)
      .finally(() => {
        refreshPromises.delete(key);
      });
    refreshPromises.set(key, promise);
    return promise;
  }
}

export async function readClaudeAuthSnapshot(options: ClaudeConnectionOptions = {}): Promise<ClaudeAuthSnapshot> {
  const resolvedFile = resolveClaudeCredentialsPath(options.credentialsFile);
  const platform = options.platform ?? process.platform;

  if (platform === "darwin" && !options.credentialsFile) {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE,
        "-w",
      ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
      return authSnapshot(parseCredentials(stdout, "macOS Keychain"), "keychain");
    } catch {
      // Claude Code falls back to the credentials file when Keychain is unavailable.
    }
  }

  let raw: string;
  try {
    raw = await readFile(resolvedFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Claude credentials ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return authSnapshot(parseCredentials(raw, resolvedFile), "file", resolvedFile);
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

function authSnapshot(
  credentials: ClaudeCredentials,
  storage: ClaudeAuthSnapshot["storage"],
  filePath?: string,
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
  };
}

/** Subscription tier of the signed-in Claude account, read from the stored credentials. */
export async function readClaudeSubscriptionType(options: ClaudeConnectionOptions = {}): Promise<string | undefined> {
  return (await readClaudeAuthSnapshot(options)).subscriptionType;
}

async function refreshClaudeAuthSnapshot(
  current: ClaudeAuthSnapshot,
  options: ClaudeConnectionOptions,
): Promise<ClaudeAuthSnapshot> {
  const response = await (options.fetch ?? fetch)(options.tokenEndpoint ?? CLAUDE_TOKEN_ENDPOINT, {
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
  });

  if (!response.ok) {
    throw new Error(`Claude token refresh failed: ${response.status} ${await response.text()}`);
  }

  const tokens = await response.json().catch(() => undefined) as ClaudeTokenResponse | undefined;
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

  await persistClaudeCredentials(current, credentials, options);
  return authSnapshot(credentials, current.storage, current.path);
}

async function persistClaudeCredentials(
  current: ClaudeAuthSnapshot,
  credentials: ClaudeCredentials,
  options: ClaudeConnectionOptions,
): Promise<void> {
  const serialized = JSON.stringify(credentials);
  if (current.storage === "keychain") {
    try {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-a",
        os.userInfo().username,
        "-s",
        options.keychainService ?? DEFAULT_CLAUDE_KEYCHAIN_SERVICE,
        "-w",
        serialized,
      ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    } catch {
      // Do not propagate execFile's command string because it contains the credential JSON.
      throw new Error("Failed to update Claude credentials in macOS Keychain");
    }
    return;
  }

  if (!current.path) {
    throw new Error("Claude credentials file path is unavailable");
  }
  await mkdir(path.dirname(current.path), { recursive: true });
  await writeFile(current.path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

function cleanToken(value?: string): string {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTokenExpiringSoon(expiresAt?: number): boolean {
  return Boolean(expiresAt && expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now());
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

interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}
