import * as assert from "node:assert";
import { usageRetryBounds } from "../../shared/usageRetry.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  CLAUDE_ORGANIZATIONS_ENDPOINT,
  CLAUDE_PROFILE_ENDPOINT,
  CLAUDE_TOKEN_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  ClaudeConnection,
  ClaudeUsageRateLimitError,
  readClaudeAuthSnapshot,
  readClaudeSubscriptionType,
  resolveClaudeCredentialsPath,
} from "../../provider/claude/index.js";
import { refreshLockPath } from "../../provider/credentialRefreshLock.js";
import { isLimitResetNotSpent } from "../../provider/limitReset.js";

/** What a 0.5 random lands on for this provider. */
const { minMs, maxMs } = usageRetryBounds("claude");
const midTtl = Math.floor(minMs + 0.5 * (maxMs - minMs + 1));

suite("Claude provider connection", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-provider-"));
  });

  teardown(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves the default Claude credentials path", () => {
    // Built with path.join, so the separator is platform-native.
    assert.ok(resolveClaudeCredentialsPath().endsWith(join(".claude", ".credentials.json")));
    assert.ok(resolveClaudeCredentialsPath().includes(`${sep}.claude${sep}`));
  });

  test("reads Claude OAuth credentials from the fallback file", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    const snapshot = await readClaudeAuthSnapshot({ credentialsFile, platform: "linux" });

    assert.strictEqual(snapshot.accessToken, "access-token");
    assert.strictEqual(snapshot.refreshToken, "refresh-token");
    assert.strictEqual(snapshot.storage, "file");
  });

  test("reads the subscription tier of the signed-in account", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);

    assert.strictEqual(await readClaudeSubscriptionType({ credentialsFile, platform: "linux" }), "pro");
  });

  test("calls the Claude usage endpoint with OAuth headers", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    let receivedUrl = "";
    let receivedHeaders = new Headers();
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      refreshLock: { dir: tmpDir },
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
      retryAtUtc: now + midTtl,
    });
  });

  test("honors Retry-After and skips requests during the rate-limit cooldown", async () => {
    const credentialsFile = writeCredentials(tmpDir, Date.now() + 60_000);
    let callCount = 0;
    let now = 1_000_000;
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      refreshLock: { dir: tmpDir },
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
      refreshLock: { dir: tmpDir },
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
    const credentialsFile = writeCredentials(tmpDir, Date.now() - 3 * 60_000);
    const calls: string[] = [];
    const connection = new ClaudeConnection({
      credentialsFile,
      platform: "linux",
      refreshLock: { dir: tmpDir },
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

  /**
   * Not racing Claude Code for the refresh token.
   *
   * Anthropic's refresh tokens are single-use and rotate with no overlap
   * window (anthropics/claude-code#54443, can1357/oh-my-pi#5396): whoever
   * presents the superseded one is told `invalid_grant`, and Claude Code
   * answers that by sending the user back to /login. A usage poller must
   * therefore never spend a grant the CLI is still relying on.
   */
  suite("sharing the refresh token with Claude Code", () => {
    test("a token that has only just expired is left for Claude Code to refresh", async () => {
      // Inside the stale window: an active CLI session refreshes on its own,
      // and stepping in here is what rotates the grant out from under it.
      const credentialsFile = writeCredentials(tmpDir, Date.now() - 30_000);
      const calls: string[] = [];
      const connection = new ClaudeConnection({
        credentialsFile,
        platform: "linux",
        refreshLock: { dir: tmpDir },
        fetch: async (input) => {
          calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
        },
      });

      await connection.usageInfo();

      assert.deepStrictEqual(calls, [CLAUDE_USAGE_ENDPOINT], "the token endpoint must not be touched");
    });

    test("credentials rotated by Claude Code are picked up instead of refreshed again", async () => {
      const credentialsFile = writeCredentials(tmpDir, Date.now() - 5 * 60_000);
      const calls: string[] = [];
      const authorizations: (string | null)[] = [];
      const connection = new ClaudeConnection({
        credentialsFile,
        platform: "linux",
        refreshLock: { dir: tmpDir },
        fetch: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          calls.push(url);
          authorizations.push(new Headers(init?.headers).get("authorization"));
          return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
        },
      });

      // Claude Code refreshes between our read and our refresh, leaving a live
      // token pair on disk.
      writeFileSync(credentialsFile, JSON.stringify({
        claudeAiOauth: {
          accessToken: "cli-access-token",
          refreshToken: "cli-refresh-token",
          expiresAt: Date.now() + 8 * 60 * 60_000,
          subscriptionType: "pro",
        },
      }));

      await connection.usageInfo();

      assert.deepStrictEqual(calls, [CLAUDE_USAGE_ENDPOINT], "the CLI's live token needs no refresh of ours");
      assert.deepStrictEqual(authorizations, ["Bearer cli-access-token"]);
    });

    test("a grant spent by Claude Code mid-request recovers from the store", async () => {
      const credentialsFile = writeCredentials(tmpDir, Date.now() - 5 * 60_000);
      const calls: string[] = [];
      const connection = new ClaudeConnection({
        credentialsFile,
        platform: "linux",
        refreshLock: { dir: tmpDir },
        fetch: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          calls.push(url);
          if (url === CLAUDE_TOKEN_ENDPOINT) {
            // Claude Code got there first and rotated the grant we presented,
            // then wrote its replacement to the store.
            writeFileSync(credentialsFile, JSON.stringify({
              claudeAiOauth: {
                accessToken: "cli-access-token",
                refreshToken: "cli-refresh-token",
                expiresAt: Date.now() + 8 * 60 * 60_000,
                subscriptionType: "pro",
              },
            }));
            return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
          }
          assert.strictEqual(new Headers(init?.headers).get("authorization"), "Bearer cli-access-token");
          return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
        },
      });

      await connection.usageInfo();

      assert.deepStrictEqual(calls, [CLAUDE_TOKEN_ENDPOINT, CLAUDE_USAGE_ENDPOINT]);
      const onDisk = JSON.parse(readFileSync(credentialsFile, "utf8")) as {
        claudeAiOauth: { refreshToken: string };
      };
      assert.strictEqual(
        onDisk.claudeAiOauth.refreshToken,
        "cli-refresh-token",
        "the CLI's rotated token must survive; overwriting it is what signs the user out",
      );
    });

    test("another window's refresh is waited on rather than duplicated", async () => {
      // Each VS Code window runs its own extension host, so nothing in this
      // process stops two of them refreshing the same account at once.
      const credentialsFile = writeCredentials(tmpDir, Date.now() - 5 * 60_000);
      const calls: string[] = [];
      const connection = new ClaudeConnection({
        credentialsFile,
        platform: "linux",
        refreshLock: { dir: tmpDir, waitMs: 0 },
        fetch: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          calls.push(url);
          assert.strictEqual(new Headers(init?.headers).get("authorization"), "Bearer access-token");
          return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
        },
      });

      // The other window is mid-refresh: it holds the lock and has not written
      // its result yet.
      writeFileSync(refreshLockPath(`file:${credentialsFile}`, tmpDir), "");

      await connection.usageInfo();

      assert.deepStrictEqual(
        calls,
        [CLAUDE_USAGE_ENDPOINT],
        "the second window must wait for the holder, not spend a second grant",
      );
    });

    test("a refusal that is not a rotated grant is still reported", async () => {
      const credentialsFile = writeCredentials(tmpDir, Date.now() - 5 * 60_000);
      const connection = new ClaudeConnection({
        credentialsFile,
        platform: "linux",
        refreshLock: { dir: tmpDir },
        fetch: async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === CLAUDE_TOKEN_ENDPOINT) {
            return new Response("upstream is down", { status: 503 });
          }
          return new Response("{}", { status: 200 });
        },
      });

      await assert.rejects(connection.usageInfo(), /Claude token refresh failed: 503/);
    });
  });

  suite("usage limit reset activation", () => {
    type Call = { url: string; method?: string; headers: Headers; body: string };

    /** Answers the profile read and the claim; `claim` decides the claim's answer per attempt. */
    function connectionFor(
      claim: (attempt: number) => Response | Promise<Response>,
      profile?: () => Response,
      cliVersionHints?: () => Array<string | undefined>,
    ) {
      const calls: Call[] = [];
      let claims = 0;
      const versionsDir = join(tmpDir, "versions");
      mkdirSync(versionsDir, { recursive: true });
      const connection = new ClaudeConnection({
        credentialsFile: writeCredentials(tmpDir, Date.now() + 60_000),
        platform: "linux",
        refreshLock: { dir: tmpDir },
        cliVersionsDir: versionsDir,
        cliVersionHints,
        fetch: async (input, init) => {
          const url = String(input);
          calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
          if (url === CLAUDE_PROFILE_ENDPOINT) {
            return profile?.() ?? new Response(JSON.stringify({ organization: { uuid: "org-123" } }), { status: 200 });
          }
          if (url === CLAUDE_TOKEN_ENDPOINT) {
            return new Response(JSON.stringify({ access_token: "access-token-2", refresh_token: "refresh-token-2", expires_in: 3600 }), { status: 200 });
          }
          claims += 1;
          return claim(claims);
        },
      });
      return { connection, calls, versionsDir };
    }

    test("claims the grant for the token's own organization as Claude Code does", async () => {
      const { connection, calls } = connectionFor(() => new Response(JSON.stringify({ result: "reset" }), { status: 200 }));

      await connection.consumeLimitReset("grant-abc");

      assert.deepStrictEqual(calls.map((call) => call.url), [
        CLAUDE_PROFILE_ENDPOINT,
        `${CLAUDE_ORGANIZATIONS_ENDPOINT}/org-123/reset_rate_limits`,
      ]);
      const claim = calls[1];
      assert.strictEqual(claim.method, "POST");
      assert.strictEqual(claim.headers.get("authorization"), "Bearer access-token");
      assert.strictEqual(claim.headers.get("content-type"), "application/json");
      assert.strictEqual(claim.headers.get("user-agent"), "claude-cli/2.1.318 (external, cli)");
      assert.strictEqual(claim.headers.get("x-app"), "cli");
      const body = JSON.parse(claim.body) as { program: string; grant_id: string; request_id: string };
      assert.strictEqual(body.program, "cedar_ember");
      assert.strictEqual(body.grant_id, "grant-abc");
      assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    });

    test("presents the newest installed Claude Code version when it is newer", async () => {
      const { connection, calls, versionsDir } = connectionFor(() => new Response(JSON.stringify({ result: "reset" }), { status: 200 }));
      for (const name of ["2.1.300", "2.10.2", "2.2.999", "not-a-version"]) {
        mkdirSync(join(versionsDir, name));
      }

      await connection.consumeLimitReset("grant-abc");

      assert.strictEqual(calls[1].headers.get("user-agent"), "claude-cli/2.10.2 (external, cli)");
    });

    test("takes the Claude Code extension's version when there is no standalone install", async () => {
      const reset = () => new Response(JSON.stringify({ result: "reset" }), { status: 200 });
      const newer = connectionFor(reset, undefined, () => ["2.1.400", undefined]);
      await newer.connection.consumeLimitReset("grant-abc");
      assert.strictEqual(newer.calls[1].headers.get("user-agent"), "claude-cli/2.1.400 (external, cli)");

      // An older extension, or none at all, never presents less than the fallback.
      const older = connectionFor(reset, undefined, () => ["2.0.1"]);
      await older.connection.consumeLimitReset("grant-abc");
      assert.strictEqual(older.calls[1].headers.get("user-agent"), "claude-cli/2.1.318 (external, cli)");
    });

    test("replays the same request id after a refused token, so a replay cannot cost a second reset", async () => {
      const { connection, calls } = connectionFor((attempt) => attempt === 1
        ? new Response("expired", { status: 401 })
        : new Response(JSON.stringify({ result: "reset" }), { status: 200 }));

      await connection.consumeLimitReset("grant-abc");

      const claims = calls.filter((call) => call.url.endsWith("/reset_rate_limits"));
      assert.strictEqual(claims.length, 2);
      assert.strictEqual(claims[0].body, claims[1].body);
      assert.strictEqual(claims[1].headers.get("authorization"), "Bearer access-token-2");
    });

    test("does not refresh the token for a 403, which refuses the account rather than the token", async () => {
      const { connection, calls } = connectionFor(() => new Response("forbidden", { status: 403 }));

      await assert.rejects(connection.consumeLimitReset("grant-abc"), (error: Error) =>
        isLimitResetNotSpent(error) && /403 forbidden/.test(error.message));
      assert.ok(!calls.some((call) => call.url === CLAUDE_TOKEN_ENDPOINT));
    });

    test("a refusal from the server is known not to have spent anything", async () => {
      const { connection } = connectionFor(() =>
        new Response(JSON.stringify({ result: "not_limited", reason: "needs_limit" }), { status: 200 }));

      await assert.rejects(connection.consumeLimitReset("grant-abc"), (error: Error) =>
        isLimitResetNotSpent(error) && /not_limited \(needs_limit\)/.test(error.message));
    });

    test("a 5xx or an unreadable answer may have spent the reset", async () => {
      for (const answer of [new Response("oops", { status: 502 }), new Response("<html>", { status: 200 })]) {
        const { connection } = connectionFor(() => answer.clone());
        await assert.rejects(connection.consumeLimitReset("grant-abc"), (error: Error) => !isLimitResetNotSpent(error));
      }
    });

    test("sends no claim when the token's organization cannot be read", async () => {
      const { connection, calls } = connectionFor(
        () => new Response("{}", { status: 200 }),
        () => new Response(JSON.stringify({ account: {} }), { status: 200 }),
      );

      await assert.rejects(connection.consumeLimitReset("grant-abc"), (error: Error) =>
        isLimitResetNotSpent(error) && /not in an organization/.test(error.message));
      assert.ok(!calls.some((call) => call.url.endsWith("/reset_rate_limits")));
    });
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
