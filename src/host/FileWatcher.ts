import type * as vscode from "vscode";
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join } from "node:path";

type WatchEntry = {
  watcher: FSWatcher;
  recursive: boolean;
};

/**
 * Watches a set of directories via `fs.watch` (recursive where supported)
 * and debounces all change events into a single callback invocation.
 */
export class FileWatcher implements vscode.Disposable {
  private watchers = new Map<string, WatchEntry>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private readonly watchRoots: string[];
  private readonly debounceMs: number;
  private readonly onChangeCallback: (changedPaths: string[]) => void;
  private readonly preferRecursiveWatch: boolean;

  constructor(
    paths: string[],
    debounceMs: number,
    onChangeCallback: (changedPaths: string[]) => void,
  ) {
    this.watchRoots = [...new Set(paths)];
    this.debounceMs = debounceMs;
    this.onChangeCallback = onChangeCallback;
    this.preferRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

    for (const dir of this.watchRoots) {
      this.tryWatchTree(dir);
    }

    // `fs.watch` can miss recursive events depending on the VS Code runtime,
    // OS, and whether source roots appear after activation. Periodic empty scans
    // use the worker's throttled hot-catalog/full-discovery path.
    if (this.watchRoots.length > 0) {
      const pollMs = Math.max(10_000, this.debounceMs * 10);
      this.pollTimer = setInterval(() => {
        for (const dir of this.watchRoots) {
          this.tryWatchTree(dir);
        }
        this.scheduleCallback(undefined);
      }, pollMs);
    }
  }

  private tryWatchTree(dir: string): void {
    if (!isDirSafe(dir)) {
      return;
    }

    if (this.preferRecursiveWatch && this.tryWatch(dir, true)) {
      return;
    }

    this.tryWatch(dir, false);
    for (const child of readDirSafe(dir)) {
      this.tryWatchTree(join(dir, child));
    }
  }

  private tryWatch(dir: string, recursive: boolean): boolean {
    const existing = this.watchers.get(dir);
    if (existing) {
      return !recursive || existing.recursive;
    }
    try {
      const watcher = watch(dir, { recursive }, (_eventType, filename) => {
        const changedPath = changedPathFromFilename(dir, filename);
        if (!recursive) {
          this.tryWatchTree(changedPath);
        }
        this.scheduleCallback(changedPath);
      });
      watcher.on("error", () => {
        if (this.watchers.get(dir)?.watcher === watcher) {
          this.watchers.delete(dir);
        }
        try {
          watcher.close();
        } catch {
          // Best-effort cleanup for watcher errors.
        }
      });
      this.watchers.set(dir, { watcher, recursive });
      return true;
    } catch {
      // Path doesn't exist or watch not supported; polling will retry later.
      return false;
    }
  }

  private scheduleCallback(changedPath: string | string[] | undefined): void {
    const paths = Array.isArray(changedPath) ? changedPath : changedPath ? [changedPath] : [];
    for (const path of paths) {
      this.pendingPaths.add(path);
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const changedPaths = [...this.pendingPaths];
      this.pendingPaths.clear();
      this.onChangeCallback(changedPaths);
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pendingPaths.clear();
    for (const { watcher } of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}

function isDirSafe(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function changedPathFromFilename(dir: string, filename: string | Buffer | null): string {
  if (!filename) {
    return dir;
  }
  const name = filename.toString();
  if (!name) {
    return dir;
  }
  return isAbsolute(name) ? name : join(dir, name);
}
