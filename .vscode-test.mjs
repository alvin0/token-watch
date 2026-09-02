import { defineConfig } from "@vscode/test-cli";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Integration suites only — the pure and property suites run under bare mocha
 * (`npm run test:unit`), so they no longer block the Extension Host and make
 * VS Code report it as unresponsive.
 *
 * The manifest claims `engines.vscode: ^1.90.0`, so CI runs the floor as well
 * as stable; a local run defaults to stable alone to avoid a second download.
 * Set `TOKEN_WATCH_VSCODE_VERSIONS=1.90.0,stable` to test both.
 */
const versions = (process.env.TOKEN_WATCH_VSCODE_VERSIONS ?? "stable")
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);

/**
 * A temp root short enough for VS Code to start in.
 *
 * VS Code puts its main IPC socket inside the user-data directory, and a UNIX
 * socket path cannot exceed ~103 characters. macOS's per-user temp directory
 * (`/var/folders/<hash>/<hash>/T`) spends most of that budget before the
 * profile subdirectories are appended, so the run died in `main.js` with
 * `listen EINVAL: invalid argument .../1.12-main.sock` and no test ever ran —
 * the local suite only worked with `TMPDIR` overridden by hand. `/tmp` is
 * short and writable wherever this runs except Windows, which has no such
 * limit and no `/tmp`.
 */
function shortTempRoot() {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/**
 * A sandboxed home for the run.
 *
 * The harness starts the REAL extension, and activation resolves its log and
 * credential paths from the home directory. Pointed at a real one it would scan
 * the developer's own Codex and Claude sessions, read their OAuth tokens, and —
 * on an expiring token — refresh and rewrite those credential files.
 */
const sandboxHome = mkdtempSync(join(shortTempRoot(), "token-watch-itest-home-"));

/**
 * A throwaway VS Code profile, so no setting from the developer's own install
 * reaches the extension.
 *
 * A sandboxed HOME alone was not enough: `tokenWatch.sources.codex.path` is an
 * application-scoped setting, so a value left in the real user profile would
 * override the sandbox and point ingestion straight back at the real logs.
 */
const sandboxUserData = join(sandboxHome, "vscode-user-data");
const sandboxExtensions = join(sandboxHome, "vscode-extensions");
mkdirSync(sandboxUserData, { recursive: true });
mkdirSync(sandboxExtensions, { recursive: true });

process.on("exit", () => {
  try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

seedFixtureLogs(sandboxHome);
const seededUsageRows = await seedPreviousVersionDatabase(sandboxUserData);

const sandboxEnv = {
  // Read by the extension to disable every outbound provider request.
  TOKEN_WATCH_TEST_MODE: "1",
  // Asserted by the isolation suite, which cannot see this config file.
  TOKEN_WATCH_TEST_HOME: sandboxHome,
  // How many rows the seeded previous-version database carries, so the
  // upgrade suite can assert none of them were lost.
  TOKEN_WATCH_TEST_SEEDED_ROWS: String(seededUsageRows),
  // `os.homedir()` reads USERPROFILE on Windows and HOME elsewhere.
  HOME: sandboxHome,
  USERPROFILE: sandboxHome,
  // Keep anything XDG-based inside the sandbox too.
  XDG_CONFIG_HOME: join(sandboxHome, ".config"),
  XDG_CACHE_HOME: join(sandboxHome, ".cache"),
};

export default defineConfig(versions.map((version) => ({
  label: `integration-${version}`,
  version,
  files: ["out/test/extension.test.js", "out/test/integration/**/*.test.js"],
  env: sandboxEnv,
  launchArgs: [
    "--user-data-dir", sandboxUserData,
    "--extensions-dir", sandboxExtensions,
    "--disable-workspace-trust",
  ],
  mocha: {
    timeout: 20000,
  },
})));

/**
 * Put a database shaped exactly like a previously shipped release into the
 * profile, so every integration run upgrades a real one instead of creating a
 * fresh one.
 *
 * Schema 8, carrying the two indexes this build drops and rows it must not
 * touch. Written before VS Code starts, which is the only moment it can be
 * done: the extension opens the database during activation.
 */
async function seedPreviousVersionDatabase(userDataDir) {
  const storage = join(userDataDir, "User", "globalStorage", "alvin0-dinhai.token-watch");
  mkdirSync(storage, { recursive: true });

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE usage_record (
      dedup_key TEXT PRIMARY KEY, file_id TEXT NOT NULL, source TEXT NOT NULL,
      session_id TEXT NOT NULL, ts_utc INTEGER NOT NULL, day_local TEXT NOT NULL,
      dow_local INTEGER NOT NULL, hour_local INTEGER NOT NULL, model TEXT NOT NULL,
      effort TEXT NOT NULL, variant_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER, context_used_tokens INTEGER,
      is_sidechain INTEGER NOT NULL DEFAULT 0, stop_reason TEXT,
      cost_usd REAL NOT NULL DEFAULT 0, cost_unknown INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tool_event (
      event_key TEXT PRIMARY KEY, record_dedup_key TEXT NOT NULL, file_id TEXT NOT NULL,
      source TEXT NOT NULL, session_id TEXT NOT NULL, ts_utc INTEGER NOT NULL,
      day_local TEXT NOT NULL, tool_name TEXT NOT NULL, model TEXT NOT NULL,
      variant_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
      is_sidechain INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE daily_aggregate (
      day_local TEXT NOT NULL, source TEXT NOT NULL, variant_id TEXT NOT NULL,
      base_model TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      unknown_cost_turns INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day_local, source, variant_id, workspace)
    );
    CREATE TABLE session_aggregate (
      source TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
      first_ts_utc INTEGER NOT NULL, last_ts_utc INTEGER NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, sidechain_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, session_id)
    );
    CREATE TABLE file_cursor (
      file_path TEXT PRIMARY KEY, file_id TEXT NOT NULL, source TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, last_byte_offset INTEGER NOT NULL,
      head_hash TEXT NOT NULL, tail_anchor_hash TEXT NOT NULL, running_totals TEXT NOT NULL,
      recent_req_ids TEXT NOT NULL, contribution TEXT NOT NULL,
      parse_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pricing (model TEXT PRIMARY KEY, input_per_1k REAL, output_per_1k REAL);
    CREATE TABLE unmapped_model (model TEXT PRIMARY KEY, seen_utc INTEGER);
    CREATE INDEX idx_rec_ts ON usage_record(ts_utc);
    CREATE INDEX idx_rec_file ON usage_record(file_id);
    CREATE INDEX idx_rec_session ON usage_record(source, session_id);
    CREATE INDEX idx_rec_day ON usage_record(day_local);
    CREATE INDEX idx_rec_session_model ON usage_record(source, session_id, model);
    CREATE INDEX idx_rec_daily_key ON usage_record(day_local, source, variant_id, workspace);
  `);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '8')");

  const rows = 40;
  for (let i = 0; i < rows; i++) {
    const ts = Date.UTC(2026, 4, 1 + (i % 20), 9, 0, i);
    const day = new Date(ts).toISOString().slice(0, 10);
    db.run(
      `INSERT INTO usage_record
       (dedup_key, file_id, source, session_id, ts_utc, day_local, dow_local, hour_local,
        model, effort, variant_id, workspace, input_tokens, output_tokens, total_tokens)
       VALUES (?, 'seed', 'codex', ?, ?, ?, 1, 9, 'gpt-5-codex', 'medium',
               'gpt-5-codex (medium)', '', 10, 5, 15)`,
      [`seed-${i}`, `seed-session-${i % 4}`, ts, day],
    );
    // Tool events carry the record key twice over, so they exercise the other
    // half of the key rewrite.
    db.run(
      `INSERT INTO tool_event
       (event_key, record_dedup_key, file_id, source, session_id, ts_utc, day_local,
        tool_name, model, variant_id, workspace)
       VALUES (?, ?, 'seed', 'codex', ?, ?, ?, 'Read', 'gpt-5-codex',
               'gpt-5-codex (medium)', '')`,
      [`seed-${i}#0`, `seed-${i}`, `seed-session-${i % 4}`, ts, day],
    );
  }

  writeFileSync(join(storage, "token-watch-v8.db"), Buffer.from(db.export()));
  db.close();
  return rows;
}

/**
 * Write a small, deterministic Codex session so activation has something real
 * to ingest. Content-free: structural fields and token counts only.
 */
function seedFixtureLogs(home) {
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "03");
  const claudeDir = join(home, ".claude", "projects", "fixture-workspace");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const sessionId = "00000000-0000-4000-8000-00000000f1c7";
  const codexLines = [
    { type: "session_meta", payload: { id: sessionId, cwd: "/fixture", cli_version: "1.0.0" } },
    { type: "turn_context", payload: { model: "gpt-5-codex", effort: "medium" } },
    {
      type: "event_msg",
      timestamp: "2026-06-03T10:00:00.000Z",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 272000,
          last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 0,
            total_tokens: 120,
          },
        },
      },
    },
  ];
  writeFileSync(
    join(codexDir, `rollout-2026-06-03T10-00-00-${sessionId}.jsonl`),
    `${codexLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );

  const claudeLine = {
    type: "assistant",
    sessionId,
    requestId: "req_fixture_1",
    timestamp: "2026-06-03T11:00:00.000Z",
    cwd: "/fixture",
    version: "1.0.0",
    message: {
      model: "claude-sonnet-4",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  };
  writeFileSync(join(claudeDir, `${sessionId}.jsonl`), `${JSON.stringify(claudeLine)}\n`, "utf8");
}
