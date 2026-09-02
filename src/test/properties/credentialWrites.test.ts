import * as assert from "node:assert";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fileIdentityOf,
  isConcurrentCredentialWriteError,
  writeFileAtomicSync,
} from "../../provider/atomicFile.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  isRequestTimeoutError,
} from "../../provider/http.js";

suite("Atomic credential writes", () => {
  let dir: string;
  let file: string;

  setup(() => {
    dir = mkdtempSync(join(tmpdir(), "token-watch-cred-"));
    file = join(dir, "credentials.json");
  });

  teardown(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the file and leaves no temp files behind", () => {
    writeFileAtomicSync(file, '{"a":1}\n');
    assert.strictEqual(readFileSync(file, "utf8"), '{"a":1}\n');
    assert.deepStrictEqual(readdirSync(dir), ["credentials.json"], "The temp file must be renamed away");
  });

  test("preserves the mode of an existing credentials file", function () {
    if (process.platform === "win32") {
      // Windows does not model POSIX permission bits.
      this.skip();
      return;
    }
    writeFileSync(file, "{}", { mode: 0o600 });
    chmodSync(file, 0o600);
    writeFileAtomicSync(file, '{"rotated":true}\n');
    assert.strictEqual(statSync(file).mode & 0o777, 0o600, "A rotated credential must not widen to 0644");
  });

  test("refuses to overwrite a file another process rotated since it was read", () => {
    writeFileSync(file, '{"token":"first"}\n');
    const identity = fileIdentityOf(file);
    assert.ok(identity);

    // The other tool rotates the credentials while we were refreshing.
    writeFileSync(file, '{"token":"rotated-elsewhere"}\n');

    assert.throws(
      () => writeFileAtomicSync(file, '{"token":"ours"}\n', { expectedIdentity: identity }),
      (error: unknown) => isConcurrentCredentialWriteError(error),
    );
    assert.strictEqual(
      readFileSync(file, "utf8"),
      '{"token":"rotated-elsewhere"}\n',
      "The other process's tokens must survive",
    );
  });

  test("an unchanged file is written normally", () => {
    writeFileSync(file, '{"token":"first"}\n');
    const identity = fileIdentityOf(file);
    assert.ok(identity);
    const next = writeFileAtomicSync(file, '{"token":"second"}\n', { expectedIdentity: identity });
    assert.strictEqual(readFileSync(file, "utf8"), '{"token":"second"}\n');
    assert.notDeepStrictEqual(next, identity, "The returned identity should describe the new file");
  });
});

suite("Provider request deadlines", () => {
  test("a hung request rejects instead of pinning the refresh forever", async () => {
    const hung: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    await assert.rejects(
      () => fetchWithTimeout(hung, "https://example.invalid/usage", { timeoutMs: 20 }),
      (error: unknown) => isRequestTimeoutError(error),
    );
  });

  test("the caller's own abort signal still wins", async () => {
    const controller = new AbortController();
    const hung: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true });
    });

    const pending = fetchWithTimeout(hung, "https://example.invalid/usage", {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(!isRequestTimeoutError(error), "A caller abort must not be reported as a timeout");
      return true;
    });
  });

  test("a prompt response reaches the caller intact", async () => {
    const ok = new Response('{"ok":true}', { status: 201, statusText: "Created", headers: { "x-test": "1" } });
    const response = await fetchWithTimeout(async () => ok, "https://example.invalid/usage", { timeoutMs: 1000 });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.headers.get("x-test"), "1");
    assert.deepStrictEqual(await response.json(), { ok: true });
  });

  test("a response with no body is passed through rather than re-wrapped", async () => {
    const empty = new Response(null, { status: 204 });
    const response = await fetchWithTimeout(async () => empty, "https://example.invalid/usage", { timeoutMs: 1000 });
    assert.strictEqual(response.status, 204);
  });

  test("a body that never finishes trips the deadline instead of hanging the caller", async () => {
    // Headers arrive immediately; the body stalls. A deadline that stopped at
    // the headers would leave response.json() pending for ever.
    const stalling: typeof fetch = async (_url, init) => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          init?.signal?.addEventListener("abort", () => {
            controller.error(new Error("aborted"));
          }, { once: true });
        },
      }),
      { status: 200 },
    );

    await assert.rejects(
      () => fetchWithTimeout(stalling, "https://example.invalid/usage", { timeoutMs: 30 }),
      (error: unknown) => isRequestTimeoutError(error),
    );
  });

  test("the default deadline is finite and short enough to be useful", () => {
    assert.ok(Number.isFinite(DEFAULT_REQUEST_TIMEOUT_MS));
    assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0 && DEFAULT_REQUEST_TIMEOUT_MS <= 60_000);
  });
});
