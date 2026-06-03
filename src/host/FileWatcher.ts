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
