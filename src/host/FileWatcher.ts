import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Watches a set of directories via `fs.watch` (recursive where supported)
 * and debounces all change events into a single callback invocation.
 */
export class FileWatcher implements vscode.Disposable {
  private watchers: FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private readonly debounceMs: number;
  private readonly onChangeCallback: (changedPaths: string[]) => void;

  constructor(
    paths: string[],
    debounceMs: number,
    onChangeCallback: (changedPaths: string[]) => void,
  ) {
    this.debounceMs = debounceMs;
    this.onChangeCallback = onChangeCallback;

    for (const dir of paths) {
      try {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          const changedPath = changedPathFromFilename(dir, filename);
          this.scheduleCallback(changedPath);
        });
        watcher.on("error", () => {
          // Silently ignore per-watcher errors (e.g. dir removed at runtime)
        });
        this.watchers.push(watcher);
      } catch {
        // Path doesn't exist or watch not supported — skip gracefully
      }
    }

    // `fs.watch` can miss recursive events depending on the VS Code runtime,
    // OS, and whether source roots appear after activation. Periodic empty-path
    // scans give the worker a cheap stat-only fallback without requiring users
    // to press manual refresh.
    if (paths.length > 0) {
      const pollMs = Math.max(30_000, this.debounceMs * 4);
      this.pollTimer = setInterval(() => {
        this.scheduleCallback(undefined);
      }, pollMs);
    }
  }

  private scheduleCallback(changedPath: string | undefined): void {
    if (changedPath) {
      this.pendingPaths.add(changedPath);
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
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}

function changedPathFromFilename(dir: string, filename: string | Buffer | null): string | undefined {
  if (!filename) {
    return undefined;
  }
  const name = filename.toString();
  if (!name) {
    return undefined;
  }
  return isAbsolute(name) ? name : join(dir, name);
}
