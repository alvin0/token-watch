import * as assert from "assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileWatcher } from "../../host/FileWatcher.js";

type WatchEntry = {
  recursive: boolean;
};

type InspectableFileWatcher = {
  watchers: Map<string, WatchEntry>;
  tryWatchTree(dir: string): void;
};

suite("FileWatcher Linux fallback", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-"));
  });

  teardown(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("watches existing subdirectories without recursive fs.watch", () => {
    const root = join(tmpDir, "sessions");
    const yearDir = join(root, "2026");
    const monthDir = join(yearDir, "06");
    const dayDir = join(monthDir, "08");
    mkdirSync(dayDir, { recursive: true });

    const watcher = withPlatform("linux", () => new FileWatcher([root], 50, () => undefined));

    try {
      const watchers = inspect(watcher).watchers;

      assert.strictEqual(watchers.get(root)?.recursive, false);
      assert.strictEqual(watchers.get(yearDir)?.recursive, false);
      assert.strictEqual(watchers.get(monthDir)?.recursive, false);
      assert.strictEqual(watchers.get(dayDir)?.recursive, false);
    } finally {
      watcher.dispose();
    }
  });

  test("adds watchers for directories created after startup", () => {
    const root = join(tmpDir, "sessions");
    mkdirSync(root, { recursive: true });

    const watcher = withPlatform("linux", () => new FileWatcher([root], 50, () => undefined));
    const newYearDir = join(root, "2026");
    const newMonthDir = join(newYearDir, "06");
    const newDayDir = join(newMonthDir, "08");

    try {
      mkdirSync(newDayDir, { recursive: true });
      inspect(watcher).tryWatchTree(root);

      const watchers = inspect(watcher).watchers;
      assert.strictEqual(watchers.get(newYearDir)?.recursive, false);
      assert.strictEqual(watchers.get(newMonthDir)?.recursive, false);
      assert.strictEqual(watchers.get(newDayDir)?.recursive, false);
    } finally {
      watcher.dispose();
    }
  });
});

function inspect(watcher: FileWatcher): InspectableFileWatcher {
  return watcher as unknown as InspectableFileWatcher;
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}
