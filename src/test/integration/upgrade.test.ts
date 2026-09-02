/**
 * Upgrading an existing installation, in a real Extension Host.
 *
 * The harness seeds a database shaped exactly like a previously shipped release
 * — schema 8, readable dedup keys, carrying the two indexes this build drops —
 * into the throwaway profile before VS Code starts. Activation therefore opens
 * and migrates an existing database on every integration run, which is the path
 * an existing user takes and the one a fresh-install test can never exercise.
 */

import * as assert from "assert";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import initSqlJs from "sql.js";
import { WORKER_REQUEST_TIMEOUT_MS, WORKER_START_TIMEOUT_MS } from "../../host/IngestionCoordinator";
import { SCHEMA_VERSION } from "../../worker/store/schema";

const EXTENSION_ID = "alvin0-dinhai.token-watch";

/**
 * How long a test that waits on a worker round-trip may take.
 *
 * Derived from the coordinator's own budgets rather than written as a figure. A
 * request made before the worker has finished starting waits for the handshake
 * first and only then arms its own timer, so the longest a call can legitimately
 * take is both budgets end to end. A shorter figure here — it used to be 20s —
 * failed the test before the code under test could report the timeout it would
 * report in production, so a slow machine looked like a hung worker with nothing
 * to go on. Whatever happens, the coordinator answers or rejects inside this, and
 * the rejection is what the assertion should see.
 */
const WORKER_ROUND_TRIP_TIMEOUT_MS = WORKER_START_TIMEOUT_MS + WORKER_REQUEST_TIMEOUT_MS + 15_000;

function databasePath(): string {
  return join(
    os.homedir(), "vscode-user-data", "User", "globalStorage", EXTENSION_ID, "token-watch-v8.db",
  );
}

async function readDatabase(): Promise<import("sql.js").Database> {
  const SQL = await initSqlJs();
  return new SQL.Database(new Uint8Array(readFileSync(databasePath())));
}

function scalar(db: import("sql.js").Database, sql: string): string {
  const result = db.exec(sql);
  const value = result[0]?.values[0]?.[0];
  return value === null || value === undefined ? "" : String(value);
}

suite("Upgrading an existing installation", () => {
  suiteSetup(async function activateAndSettle() {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "Extension should be found");
    await ext.activate();
    // Activation ingests and flushes on a debounce; give the worker a moment to
    // write the upgraded snapshot back before reading the file.
    await new Promise((resolve) => setTimeout(resolve, 4000));
  });

  test("the seeded previous-version database is the one that was opened", () => {
    assert.ok(existsSync(databasePath()), `no database at ${databasePath()}`);
  });

  test("activation succeeds against an existing database", () => {
    // The upgrade does real work on first open — dropping indexes and compacting
    // — inside the worker's startup handshake. If that ever outgrew the budget
    // the worker would be killed and restarted in a loop.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    assert.strictEqual(ext.isActive, true, "the extension must survive opening an existing database");
  });

  test("the database is migrated to the schema this build writes", async () => {
    // Compacting the dedup keys is a real format change: a build from before it
    // would insert a second copy of any turn it re-read instead of replacing it,
    // so the version has to move and lock those builds out.
    const db = await readDatabase();
    try {
      assert.strictEqual(
        scalar(db, "SELECT value FROM meta WHERE key = 'schema_version'"),
        String(SCHEMA_VERSION),
      );
    } finally {
      db.close();
    }
  });

  test("the migration compacted the dedup keys", async () => {
    const db = await readDatabase();
    try {
      const longest = Number(scalar(db, "SELECT MAX(LENGTH(dedup_key)) FROM usage_record"));
      assert.strictEqual(longest, 16, `every stored key should be 16 bytes, saw ${longest}`);
      const rows = Number(scalar(db, "SELECT COUNT(*) FROM usage_record"));
      const distinct = Number(scalar(db, "SELECT COUNT(DISTINCT dedup_key) FROM usage_record"));
      assert.strictEqual(distinct, rows, "no two turns may collapse onto one key");
    } finally {
      db.close();
    }
  });

  test("the redundant indexes are gone and the load-bearing ones remain", async () => {
    const db = await readDatabase();
    try {
      const names = db.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_record'",
      )[0]?.values.map((row) => String(row[0])) ?? [];
      assert.ok(names.length > 0, "the table should still have indexes");
      assert.ok(!names.includes("idx_rec_session"), `idx_rec_session should be gone: ${names}`);
      assert.ok(!names.includes("idx_rec_day"), `idx_rec_day should be gone: ${names}`);
      assert.ok(names.includes("idx_rec_session_model"), `${names}`);
      assert.ok(names.includes("idx_rec_daily_key"), `${names}`);
    } finally {
      db.close();
    }
  });

  test("every row the previous version had is still there", async () => {
    // The point of the whole exercise: an upgrade must not cost the user data.
    const expected = Number(process.env.TOKEN_WATCH_TEST_SEEDED_ROWS ?? "0");
    assert.ok(expected > 0, "the harness should report how many rows it seeded");

    const db = await readDatabase();
    try {
      const seeded = Number(scalar(db, "SELECT COUNT(*) FROM usage_record WHERE file_id = 'seed'"));
      assert.strictEqual(seeded, expected, "no seeded row may be lost by the upgrade");
      const tokens = Number(scalar(db, "SELECT SUM(total_tokens) FROM usage_record WHERE file_id = 'seed'"));
      assert.strictEqual(tokens, expected * 15, "and their token counts must be untouched");
    } finally {
      db.close();
    }
  });

  test("the tool events seeded alongside them still point at their turns", async () => {
    // Each event stores the record key twice over, so the rewrite has to move
    // both. An event that stopped joining would quietly drop out of the tool
    // table without any error to notice.
    const expected = Number(process.env.TOKEN_WATCH_TEST_SEEDED_ROWS ?? "0");
    const db = await readDatabase();
    try {
      const joined = Number(scalar(
        db,
        "SELECT COUNT(*) FROM tool_event t JOIN usage_record r ON r.dedup_key = t.record_dedup_key"
        + " WHERE t.file_id = 'seed'",
      ));
      assert.strictEqual(joined, expected, "every seeded tool event must still join its turn");
      const longest = Number(scalar(db, "SELECT MAX(LENGTH(event_key)) FROM tool_event"));
      assert.strictEqual(longest, 16, `event keys should be compact too, saw ${longest}`);
    } finally {
      db.close();
    }
  });

  test("retention is off by default, so nothing was pruned", async () => {
    const db = await readDatabase();
    try {
      assert.strictEqual(
        scalar(db, "SELECT value FROM meta WHERE key = 'raw_retained_from_day'"),
        "",
        "an upgrade must not delete anything on its own",
      );
    } finally {
      db.close();
    }
  });

  test("the diagnostics report says the database is complete", async function checkReport() {
    this.timeout(WORKER_ROUND_TRIP_TIMEOUT_MS);
    await vscode.commands.executeCommand("token-watch.showDiagnostics");
    const text = vscode.window.activeTextEditor?.document.getText() ?? "";
    assert.ok(text.includes("# Token Watch Diagnostics"), "the report should have opened");
    assert.ok(text.includes("## Retention"), `the report should cover retention:\n${text.slice(0, 400)}`);
    assert.ok(
      text.includes("kept for every day"),
      "with retention off, the report should say every day still has per-turn detail",
    );
  });

  test("the report says where the worker spent its time", async function checkTiming() {
    this.timeout(WORKER_ROUND_TRIP_TIMEOUT_MS);
    // Measured on the machine that ran it. Benchmarks written here have been
    // repeatedly optimistic — they call the code directly, on a fast disk, with
    // nothing competing — so the wait a user actually sees has to be something
    // they can read back rather than something to guess at.
    await vscode.commands.executeCommand("token-watch.showDiagnostics");
    const text = vscode.window.activeTextEditor?.document.getText() ?? "";
    assert.ok(text.includes("## Timing"), "the report should have a timing section");
    assert.ok(
      text.includes("Longest the worker went without answering"),
      "and should say how long the worker could not answer, which is what a stuck panel is",
    );
    assert.match(
      text,
      /init: (migrate schema|open database)/,
      "and should name the startup steps it measured",
    );
  });
});
