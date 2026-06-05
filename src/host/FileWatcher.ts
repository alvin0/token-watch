import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Watches a set of directories via `fs.watch` (recursive where supported)
 * and debounces all change events into a single callback invocation.
 */
export class FileWatcher implements vscode.Disposable {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private readonly watchRoots: string[];
  private readonly debounceMs: number;
  private readonly onChangeCallback: (changedPaths: string[]) => void;

  constructor(
    paths: string[],
    debounceMs: number,
    onChangeCallback: (changedPaths: string[]) => void,
  ) {
    this.watchRoots = [...new Set(paths)];
    this.debounceMs = debounceMs;
    this.onChangeCallback = onChangeCallback;

    for (const dir of this.watchRoots) {
      this.tryWatch(dir);
    }

    // `fs.watch` can miss recursive events depending on the VS Code runtime,
    // OS, and whether source roots appear after activation. Periodic empty scans
    // use the worker's throttled hot-catalog/full-discovery path.
    if (this.watchRoots.length > 0) {
      const pollMs = Math.max(10_000, this.debounceMs * 10);
      this.pollTimer = setInterval(() => {
        for (const dir of this.watchRoots) {
          this.tryWatch(dir);
        }
        this.scheduleCallback(undefined);
      }, pollMs);
    }
  }

  private tryWatch(dir: string): void {
    if (this.watchers.has(dir)) {
      return;
    }
    try {
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        const changedPath = changedPathFromFilename(dir, filename);
        this.scheduleCallback(changedPath);
      });
      watcher.on("error", () => {
        this.watchers.delete(dir);
        try {
          watcher.close();
        } catch {
          // Best-effort cleanup for watcher errors.
        }
      });
      this.watchers.set(dir, watcher);
    } catch {
      // Path doesn't exist or watch not supported — polling will retry later.
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
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
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
