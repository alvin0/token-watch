import * as vscode from "vscode";
import { watch, type FSWatcher } from "node:fs";

/**
 * Watches a set of directories via `fs.watch` (recursive where supported)
 * and debounces all change events into a single callback invocation.
 */
export class FileWatcher implements vscode.Disposable {
  private watchers: FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly onChangeCallback: () => void;

  constructor(
    paths: string[],
    debounceMs: number,
    onChangeCallback: () => void,
  ) {
    this.debounceMs = debounceMs;
    this.onChangeCallback = onChangeCallback;

    for (const dir of paths) {
      try {
        const watcher = watch(dir, { recursive: true }, () => {
          this.scheduleCallback();
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

  private scheduleCallback(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChangeCallback();
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
