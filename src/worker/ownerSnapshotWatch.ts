/**
 * Notice when the owning window writes a new database snapshot.
 *
 * A follower used to reload only when its own log watcher fired. That races
 * the owner: both see the same log change, the follower checks the file before
 * the owner has flushed, finds nothing new, and then shows stale figures until
 * the next change — which, after the last turn of a session, may never come.
 *
 * Polls the file's stat rather than using `fs.watch`: every flush replaces the
 * database by rename, which a watch on the file itself does not survive on
 * every platform. Returns the unsubscribe.
 *
 * This module MUST NOT import `vscode`.
 */

import { unwatchFile, watchFile, type Stats } from "node:fs";

/** A stat every couple of seconds; the reload itself only runs when the file changed. */
export const OWNER_SNAPSHOT_POLL_MS = 2_000;

export function watchOwnerSnapshot(
  dbPath: string,
  onChange: () => void,
  pollMs = OWNER_SNAPSHOT_POLL_MS,
): () => void {
  const listener = (current: Stats, previous: Stats) => {
    if (current.mtimeMs === previous.mtimeMs && current.ino === previous.ino && current.size === previous.size) {
      return;
    }
    onChange();
  };
  watchFile(dbPath, { interval: pollMs, persistent: false }, listener);
  return () => unwatchFile(dbPath, listener);
}
