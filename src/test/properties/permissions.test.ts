// Feature: token-tracking, Task 11.4: Permissions/missing-dir integration test.
//
// Verifies that an unreadable/missing source dir produces no throw and
// ingestion continues with the other (valid) source.

import * as assert from "assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scan, type SourceRoots } from "../../worker/discovery.js";

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
});
