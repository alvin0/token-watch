// Feature: token-tracking, Task 11.4: Permissions/missing-dir integration test.
//
// Verifies that an unreadable/missing source dir produces no throw and
// ingestion continues with the other (valid) source.

import * as assert from "assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scan, scanChanged, type SourceRoots } from "../../worker/discovery.js";

suite("Permissions/missing-dir integration test", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "perms-"));
  });

  teardown(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Missing source dir does not throw and other source still returns candidates", () => {
    // Create a valid Codex directory structure with a file
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2025", "01", "15");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "rollout-abc.jsonl"), '{"type":"session_meta"}\n');

    // Use a non-existent path for Claude
    const nonExistentPath = join(tmpDir, "does-not-exist", "nope");

    const roots: SourceRoots = {
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: true, path: nonExistentPath },
    };

    // scan() should NOT throw
    const candidates = scan(roots);

    // Should find the Codex file
    assert.ok(candidates.length >= 1, "Should find at least one candidate from valid source");
    assert.strictEqual(candidates[0].source, "codex");
    assert.ok(candidates[0].filePath.includes("rollout-abc.jsonl"));
  });

  test("Both sources missing returns empty array without throwing", () => {
    const roots: SourceRoots = {
      codex: { enabled: true, path: join(tmpDir, "no-codex") },
      claude: { enabled: true, path: join(tmpDir, "no-claude") },
    };

    const candidates = scan(roots);
    assert.strictEqual(candidates.length, 0);
  });

  test("Disabled source is not scanned even if path exists", () => {
    // Create a valid Codex directory
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2025", "01", "15");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "rollout-xyz.jsonl"), '{"type":"session_meta"}\n');

    const roots: SourceRoots = {
      codex: { enabled: false, path: codexRoot },
      claude: { enabled: true, path: join(tmpDir, "no-claude") },
    };

    const candidates = scan(roots);
    assert.strictEqual(candidates.length, 0, "Disabled source should not produce candidates");
  });

  test("Claude nested JSONL files are discovered", () => {
    const claudeRoot = join(tmpDir, "claude-projects");
    const nestedDir = join(claudeRoot, "project-a", "session-a", "subagents");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "agent-a.jsonl"), '{"type":"assistant"}\n');

    const roots: SourceRoots = {
      codex: { enabled: false, path: join(tmpDir, "no-codex") },
      claude: { enabled: true, path: claudeRoot },
    };

    const candidates = scan(roots);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "claude");
    assert.ok(candidates[0].filePath.endsWith("agent-a.jsonl"));
  });

  test("Codex non-rollout JSONL files are discovered", () => {
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2026", "06", "08");
    mkdirSync(dayDir, { recursive: true });
    const codexFile = join(dayDir, "session-live.jsonl");
    writeFileSync(codexFile, '{"type":"session_meta"}\n');

    const candidates = scan({
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: false, path: join(tmpDir, "no-claude") },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("Symlinked source subdirectories are discovered", function (this: Mocha.Context) {
    const codexRoot = join(tmpDir, "codex-sessions");
    const realRoot = join(tmpDir, "real-codex-sessions");
    const realDayDir = join(realRoot, "2026", "06", "08");
    const linkedYearDir = join(codexRoot, "2026");
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(realDayDir, { recursive: true });
    const codexFile = join(linkedYearDir, "06", "08", "session-live.jsonl");
    writeFileSync(join(realDayDir, "session-live.jsonl"), '{"type":"session_meta"}\n');

    try {
      symlinkSync(join(realRoot, "2026"), linkedYearDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      this.skip();
    }

    const candidates = scan({
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: false, path: join(tmpDir, "no-claude") },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("scanChanged returns only changed log candidates", () => {
    const codexRoot = join(tmpDir, "codex-sessions");
    const codexDir = join(codexRoot, "2026", "06", "03");
    const claudeRoot = join(tmpDir, "claude-projects");
    const claudeDir = join(claudeRoot, "project-a");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    const codexFile = join(codexDir, "rollout-live.jsonl");
    const claudeFile = join(claudeDir, "session-live.jsonl");
    const ignoredFile = join(codexDir, "notes.txt");
    writeFileSync(codexFile, '{"type":"session_meta"}\n');
    writeFileSync(claudeFile, '{"type":"assistant"}\n');
    writeFileSync(ignoredFile, "ignore me\n");

    const roots: SourceRoots = {
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: true, path: claudeRoot },
    };

    const candidates = scanChanged([codexFile, ignoredFile], roots);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("scanChanged accepts files inside dot-prefixed directories", () => {
    const claudeRoot = join(tmpDir, "claude-projects");
    const dotDir = join(claudeRoot, "..not-outside");
    mkdirSync(dotDir, { recursive: true });

    const claudeFile = join(dotDir, "session-live.jsonl");
    writeFileSync(claudeFile, '{"type":"assistant"}\n');

    const candidates = scanChanged([claudeFile], {
      codex: { enabled: false, path: join(tmpDir, "no-codex") },
      claude: { enabled: true, path: claudeRoot },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "claude");
    assert.strictEqual(candidates[0].filePath, claudeFile);
  });

  test("scanChanged expands changed Codex directories", () => {
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2026", "06", "03");
    mkdirSync(dayDir, { recursive: true });

    const codexFile = join(dayDir, "rollout-live.jsonl");
    writeFileSync(codexFile, '{"type":"session_meta"}\n');

    const candidates = scanChanged([dayDir], {
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: false, path: join(tmpDir, "no-claude") },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("scanChanged expands the Codex source root", () => {
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2026", "06", "03");
    mkdirSync(dayDir, { recursive: true });

    const codexFile = join(dayDir, "rollout-live.jsonl");
    writeFileSync(codexFile, '{"type":"session_meta"}\n');

    const candidates = scanChanged([codexRoot], {
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: false, path: join(tmpDir, "no-claude") },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("scanChanged accepts non-rollout Codex JSONL files", () => {
    const codexRoot = join(tmpDir, "codex-sessions");
    const dayDir = join(codexRoot, "2026", "06", "08");
    mkdirSync(dayDir, { recursive: true });

    const codexFile = join(dayDir, "session-live.jsonl");
    writeFileSync(codexFile, '{"type":"session_meta"}\n');

    const candidates = scanChanged([codexFile], {
      codex: { enabled: true, path: codexRoot },
      claude: { enabled: false, path: join(tmpDir, "no-claude") },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "codex");
    assert.strictEqual(candidates[0].filePath, codexFile);
  });

  test("scanChanged expands changed Claude directories", () => {
    const claudeRoot = join(tmpDir, "claude-projects");
    const sessionDir = join(claudeRoot, "project-a", "session-a");
    mkdirSync(sessionDir, { recursive: true });

    const claudeFile = join(sessionDir, "session-live.jsonl");
    writeFileSync(claudeFile, '{"type":"assistant"}\n');

    const candidates = scanChanged([sessionDir], {
      codex: { enabled: false, path: join(tmpDir, "no-codex") },
      claude: { enabled: true, path: claudeRoot },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "claude");
    assert.strictEqual(candidates[0].filePath, claudeFile);
  });

  test("scanChanged expands the Claude source root", () => {
    const claudeRoot = join(tmpDir, "claude-projects");
    const sessionDir = join(claudeRoot, "project-a", "session-a");
    mkdirSync(sessionDir, { recursive: true });

    const claudeFile = join(sessionDir, "session-live.jsonl");
    writeFileSync(claudeFile, '{"type":"assistant"}\n');

    const candidates = scanChanged([claudeRoot], {
      codex: { enabled: false, path: join(tmpDir, "no-codex") },
      claude: { enabled: true, path: claudeRoot },
    });

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].source, "claude");
    assert.strictEqual(candidates[0].filePath, claudeFile);
  });
});
