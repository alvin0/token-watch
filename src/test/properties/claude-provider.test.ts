import * as assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_TOKEN_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  ClaudeConnection,
  ClaudeUsageRateLimitError,
  readClaudeAuthSnapshot,
  resolveClaudeCredentialsPath,
} from "../../provider/claude/index.js";

suite("Claude provider connection", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-provider-"));
  });

  teardown(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves the default Claude credentials path", () => {
    assert.ok(resolveClaudeCredentialsPath().endsWith("/.claude/.credentials.json"));
  });

  test("reads Claude OAuth credentials from the fallback file", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    const snapshot = await readClaudeAuthSnapshot({ credentialsFile, platform: "linux" });

    assert.strictEqual(snapshot.accessToken, "access-token");
    assert.strictEqual(snapshot.refreshToken, "refresh-token");
    assert.strictEqual(snapshot.storage, "file");
  });

  test("calls the Claude usage endpoint with OAuth headers", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    let receivedUrl = "";
    let receivedHeaders = new Headers();
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      fetch: async (input, init) => {
        receivedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        receivedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
      },
    });

    await connection.usageInfo();

    assert.strictEqual(receivedUrl, CLAUDE_USAGE_ENDPOINT);
    assert.strictEqual(receivedHeaders.get("authorization"), "Bearer access-token");
    assert.strictEqual(receivedHeaders.get("anthropic-beta"), "oauth-2025-04-20");
  });

  test("deduplicates concurrent and recent usage requests across connection instances", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    const now = 1_000_000;
    let callCount = 0;
    const fetchUsage: typeof fetch = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
    };
    const options = { credentialsFile, platform: "linux" as const, fetch: fetchUsage, now: () => now, random: () => 0.5 };

    const [first, second] = await Promise.all([
      new ClaudeConnection(options).usageInfo(),
      new ClaudeConnection(options).usageInfo(),
    ]);
    const third = await new ClaudeConnection(options).usageInfo();

    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(second, third);
    assert.strictEqual(callCount, 1);
    assert.deepStrictEqual(new ClaudeConnection(options).usageCacheInfo(), {
      cachedAtUtc: now,
      retryAtUtc: now + 105_000,
    });
  });

  test("honors Retry-After and skips requests during the rate-limit cooldown", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    let callCount = 0;
    let now = 1_000_000;
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      now: () => now,
      fetch: async () => {
        callCount += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    });

    await assert.rejects(
      connection.usageInfo(),
      (error: unknown) => error instanceof ClaudeUsageRateLimitError
        && error.retryAt === now + 120_000
        && !error.fromCooldown,
    );
    await assert.rejects(
      connection.usageInfo(),
      (error: unknown) => error instanceof ClaudeUsageRateLimitError
        && error.retryAt === now + 120_000
        && error.fromCooldown,
    );
    assert.strictEqual(callCount, 1);

    now += 120_000;
    await assert.rejects(connection.usageInfo(), ClaudeUsageRateLimitError);
    assert.strictEqual(callCount, 2);
  });

  test("applies a retry time after a non-rate-limit usage failure", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    const now = 1_000_000;
    let callCount = 0;
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      now: () => now,
      fetch: async () => {
        callCount += 1;
        throw new Error("network unavailable");
      },
    });

    await assert.rejects(connection.usageInfo(), /network unavailable/);
    await assert.rejects(connection.usageInfo({ force: true }), ClaudeUsageRateLimitError);
    assert.strictEqual(callCount, 1);
    assert.deepStrictEqual(connection.usageCacheInfo(), {
      retryAtUtc: now + 60_000,
      retryPending: true,
    });
  });

  test("refreshes expired Claude OAuth credentials and persists rotated tokens", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() - 60_000);
    const calls: string[] = [];
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === CLAUDE_TOKEN_ENDPOINT) {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          assert.strictEqual(body.grant_type, "refresh_token");
          assert.strictEqual(body.refresh_token, "refresh-token");
          return new Response(JSON.stringify({
            access_token: "access-token-new",
            refresh_token: "refresh-token-new",
            expires_in: 28_800,
          }), { status: 200 });
        }
        assert.strictEqual(new Headers(init?.headers).get("authorization"), "Bearer access-token-new");
        return new Response(JSON.stringify({ seven_day: { utilization: 20 } }), { status: 200 });
      },
    });

    await connection.usageInfo();

    const updated = JSON.parse(readFileSync(credentialsFile, "utf8")) as {
      claudeAiOauth: { accessToken: string; refreshToken: string };
    };
    assert.deepStrictEqual(calls, [
      `POST ${CLAUDE_TOKEN_ENDPOINT}`,
      `GET ${CLAUDE_USAGE_ENDPOINT}`,
    ]);
    assert.strictEqual(updated.claudeAiOauth.accessToken, "access-token-new");
    assert.strictEqual(updated.claudeAiOauth.refreshToken, "refresh-token-new");
  });
});

function writeCredentials(dir: string, expiresAt: number): string {
  const file = join(dir, ".credentials.json");
  writeFileSync(file, JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt,
      subscriptionType: "pro",
    },
  }));
  return file;
}
