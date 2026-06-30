import * as assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as os from "node:os";

import {
  CodexConnection,
  WHAM_ENVIRONMENTS_ENDPOINT,
  WHAM_USAGE_ENDPOINT,
  readCodexAuthMode,
  readCodexAuthSnapshot,
  resolveCodexAuthPath,
} from "../../provider/codex/index.js";

suite("Codex provider connection", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "codex-provider-"));
  });

  teardown(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves the default Codex auth path under the home directory", () => {
    const expected = join(os.homedir(), ".codex", "auth.json");
    assert.strictEqual(resolveCodexAuthPath(), expected);
    assert.strictEqual(resolveCodexAuthPath("~/.codex/auth.json"), expected);
  });

  test("reads auth_mode directly from ~/.codex/auth.json", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "browser",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "account-123",
          },
        },
        null,
        2,
      ),
    );

    const authMode = await readCodexAuthMode(authFile);

    assert.strictEqual(authMode, "browser");
  });

  test("rejects unsupported auth_mode when reading auth snapshot", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "browser",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "account-123",
          },
        },
        null,
        2,
      ),
    );

    await assert.rejects(readCodexAuthSnapshot(authFile), /Unsupported Codex auth_mode "browser"/);
  });

  test("reads access and refresh tokens directly from ~/.codex/auth.json", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "account-123",
          },
        },
        null,
        2,
      ),
    );

    const snapshot = await readCodexAuthSnapshot(authFile);

    assert.strictEqual(snapshot.path, authFile);
    assert.strictEqual(snapshot.accessToken, "access-token");
    assert.strictEqual(snapshot.refreshToken, "refresh-token");
    assert.strictEqual(snapshot.accountId, "account-123");
  });

  test("calls WHAM_USAGE_ENDPOINT with Codex auth headers", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            account_id: "account-123",
          },
        },
        null,
        2,
      ),
    );

    let receivedUrl = "";
    let receivedMethod = "";
    let receivedHeaders = new Headers();

    const connection = new CodexConnection({
      authFile,
      fetch: async (input, init) => {
        receivedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        receivedMethod = init?.method ?? "GET";
        receivedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await connection.usage();

    assert.strictEqual(receivedUrl, WHAM_USAGE_ENDPOINT);
    assert.strictEqual(receivedMethod, "GET");
    assert.strictEqual(receivedHeaders.get("authorization"), "Bearer access-token");
    assert.strictEqual(receivedHeaders.get("ChatGPT-Account-Id"), "account-123");
    assert.strictEqual(receivedHeaders.get("accept"), "application/json");
    assert.strictEqual(response.status, 200);
  });

  test("parses usage info JSON from WHAM_USAGE_ENDPOINT", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
          },
        },
        null,
        2,
      ),
    );

    const connection = new CodexConnection({
      authFile,
      fetch: async () =>
        new Response(
          JSON.stringify({
            usage: {
              remaining: 1234,
              period: "monthly",
            },
            account_id: "account-123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const info = await connection.usageInfo<{
      usage: { remaining: number; period: string };
      account_id: string;
    }>();

    assert.deepStrictEqual(info, {
      usage: {
        remaining: 1234,
        period: "monthly",
      },
      account_id: "account-123",
    });
  });

  test("parses environments info JSON from WHAM_ENVIRONMENTS_ENDPOINT", async () => {
    const authFile = join(tmpDir, "auth.json");
    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
          },
        },
        null,
        2,
      ),
    );

    let receivedUrl = "";
    const connection = new CodexConnection({
      authFile,
      fetch: async (input) => {
        receivedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return new Response(
          JSON.stringify({
            environments: [
              { id: "default", label: "Default" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const info = await connection.environmentsInfo<{
      environments: Array<{ id: string; label: string }>;
    }>();

    assert.strictEqual(receivedUrl, WHAM_ENVIRONMENTS_ENDPOINT);
    assert.deepStrictEqual(info, {
      environments: [
        { id: "default", label: "Default" },
      ],
    });
  });

  test("refreshes expired Codex auth, rewrites ~/.codex/auth.json, then retries usage", async () => {
    const authFile = join(tmpDir, "auth.json");
    const oldAccessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, chatgpt_account_id: "account-123" });
    const newAccessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, chatgpt_account_id: "account-123" });
    const newRefreshToken = "refresh-token-new";

    writeFileSync(
      authFile,
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            access_token: oldAccessToken,
            refresh_token: "refresh-token-old",
            account_id: "account-123",
          },
        },
        null,
        2,
      ),
    );

    const calls: Array<string> = [];
    const connection = new CodexConnection({
      authFile,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(`${init?.method ?? "GET"} ${url}`);

        if (url.includes("/oauth/token")) {
          assert.strictEqual(init?.method, "POST");
          const body = init?.body as string;
          assert.ok(body.includes("grant_type=refresh_token"));
          assert.ok(body.includes("refresh_token=refresh-token-old"));
          return new Response(
            JSON.stringify({
              access_token: newAccessToken,
              refresh_token: newRefreshToken,
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (calls.filter((call) => call.startsWith("GET ")).length === 1) {
          assert.strictEqual(new Headers(init?.headers).get("authorization"), `Bearer ${oldAccessToken}`);
          return new Response("token expired", { status: 401 });
        }

        assert.strictEqual(new Headers(init?.headers).get("authorization"), `Bearer ${newAccessToken}`);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await connection.usage();
    const updated = JSON.parse(readFileSync(authFile, "utf8")) as {
      tokens: {
        access_token: string;
        refresh_token: string;
        account_id: string;
      };
    };

    assert.strictEqual(response.status, 200);
    assert.strictEqual(updated.tokens.access_token, newAccessToken);
    assert.strictEqual(updated.tokens.refresh_token, newRefreshToken);
    assert.strictEqual(updated.tokens.account_id, "account-123");
  });
});

function makeJwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}