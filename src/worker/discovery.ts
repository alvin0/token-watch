import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Source } from "../shared/types.js";

export interface CandidateFile {
  filePath: string;
  source: Source;
  size: number;
  mtimeMs: number;
  fileId: string; // `${dev}:${ino}` (fallback `${birthtimeMs}:${path}`)
}

export interface SourceRoots {
  codex?: { enabled: boolean; path: string };
  claude?: { enabled: boolean; path: string };
}

/**
 * Cheap stat-only scan of source directories. NO content reads, NO date-in-path
 * logic for freshness (Req 4.5). Returns all candidate JSONL files with their
 * stat metadata, sorted by mtimeMs descending (most recent first, Req 4.26).
 */
export function scan(roots: SourceRoots): CandidateFile[] {
  const results: CandidateFile[] = [];

  if (roots.codex?.enabled) {
    walkCodex(roots.codex.path, results);
  }
  if (roots.claude?.enabled) {
    walkClaude(roots.claude.path, results);
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/** Recursively find all `rollout-*.jsonl` files under the Codex sessions root. */
function walkCodex(root: string, out: CandidateFile[]): void {
  walkDir(root, (filePath) => {
    const name = basename(filePath);
    if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
      const candidate = statCandidate(filePath, "codex");
      if (candidate) out.push(candidate);
    }
  });
}

/** Find all `*.jsonl` files one level deep inside project subdirectories. */
function walkClaude(root: string, out: CandidateFile[]): void {
  // root is already the projects directory (e.g. ~/.claude/projects)
  const subdirs = readDirSafe(root);
  for (const sub of subdirs) {
    const subPath = join(root, sub);
    if (!isDirSafe(subPath)) { continue; }
    const files = readDirSafe(subPath);
    for (const file of files) {
      if (file.endsWith(".jsonl")) {
        const filePath = join(subPath, file);
        const candidate = statCandidate(filePath, "claude");
        if (candidate) { out.push(candidate); }
      }
    }
  }
}

/** Stat a file and build a CandidateFile, or null if stat fails. */
function statCandidate(filePath: string, source: Source): CandidateFile | null {
  try {
    const stat = statSync(filePath);
    const fileId = stat.ino > 0
      ? `${stat.dev}:${stat.ino}`
      : `${stat.birthtimeMs}:${filePath}`;
    return { filePath, source, size: stat.size, mtimeMs: stat.mtimeMs, fileId };
  } catch {
    return null;
  }
}

/** Recursively walk a directory, calling `visitor` for each file path. */
function walkDir(dir: string, visitor: (filePath: string) => void): void {
  const entries = readDirSafe(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (isDirSafe(full)) {
      walkDir(full, visitor);
    } else {
      visitor(full);
    }
  }
}

/** Read directory entries, returning [] on any error. */
function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Check if a path is a directory, returning false on any error. */
function isDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
