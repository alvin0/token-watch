import * as assert from "assert";

import { dedupMigrationCanRebuild, storedFilesCanRebuild } from "../../worker/migration.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { Source } from "../../shared/types.js";

function candidate(source: Source, filePath: string, fileId = `${source}:1`): CandidateFile {
  return {
    filePath,
    source,
    size: 1,
    mtimeMs: 1,
    fileId,
  };
}

suite("Migration guard tests", () => {
  test("dedup migration is blocked when no rebuild candidates exist", () => {
    assert.strictEqual(
      dedupMigrationCanRebuild(new Set<Source>(["codex"]), []),
      false,
    );
  });

  test("dedup migration is blocked when candidates do not cover stored sources", () => {
    assert.strictEqual(
      dedupMigrationCanRebuild(
        new Set<Source>(["codex", "claude"]),
        [candidate("codex", "/tmp/rollout-live.jsonl")],
      ),
      false,
    );
  });

  test("dedup migration can run when candidates cover all stored sources", () => {
    assert.strictEqual(
      dedupMigrationCanRebuild(
        new Set<Source>(["codex", "claude"]),
        [
          candidate("codex", "/tmp/rollout-live.jsonl"),
          candidate("claude", "/tmp/session-live.jsonl"),
        ],
      ),
      true,
    );
  });

  test("stored-file rebuild guard requires exact path, source, and file identity coverage", () => {
    const stored = [
      { source: "codex" as const, filePath: "/tmp/a.jsonl", fileId: "codex:a" },
      { source: "claude" as const, filePath: "/tmp/b.jsonl", fileId: "claude:b" },
    ];

    assert.strictEqual(
      storedFilesCanRebuild(stored, [
        candidate("codex", "/tmp/a.jsonl", "codex:a"),
        candidate("claude", "/tmp/b.jsonl", "claude:b"),
      ]),
      true,
    );

    assert.strictEqual(
      storedFilesCanRebuild(stored, [
        candidate("codex", "/tmp/a.jsonl", "codex:a"),
        candidate("claude", "/tmp/b.jsonl", "claude:changed"),
      ]),
      false,
    );
  });
});
