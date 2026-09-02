/**
 * Test-isolation switches, read once from the environment.
 *
 * The integration harness runs a real Extension Host with the real extension.
 * Without these, activation would scan the developer's own Codex and Claude
 * logs, read their OAuth credentials, call the providers' quota APIs, and — if
 * a token happened to be expiring — refresh and REWRITE those credential files.
 * A test suite must never touch a person's real sign-in state.
 *
 * The harness sets `TOKEN_WATCH_TEST_MODE=1`, plus a sandboxed HOME so the
 * default log and credential paths resolve inside a temporary directory.
 *
 * This module MUST NOT import `vscode`.
 */

/** True when running under the extension's own integration harness. */
export function isTestMode(): boolean {
  return process.env.TOKEN_WATCH_TEST_MODE === "1";
}

/**
 * Whether provider quota requests are allowed.
 *
 * Off in test mode: these are authenticated calls to third-party services, and
 * a failing token refresh can rewrite the credentials file the real CLI uses.
 */
export function providerRequestsEnabled(): boolean {
  return !isTestMode();
}
