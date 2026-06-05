import * as assert from "assert";

import { dedupMigrationCanRebuild } from "../../worker/migration.js";
import type { CandidateFile } from "../../worker/discovery.js";
import type { Source } from "../../shared/types.js";

function candidate(source: Source, filePath: string): CandidateFile {
  return {
    filePath,
    source,
    size: 1,
    mtimeMs: 1,
    fileId: `${source}:1`,
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
});
