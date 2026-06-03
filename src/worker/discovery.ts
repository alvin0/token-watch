import { readdirSync, statSync } from "node:fs";
import { join, basename, isAbsolute, relative, resolve, sep } from "node:path";
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

/**
 * Build candidates only for files reported by the watcher. This keeps active
 * Codex/Claude updates fast by avoiding a full root scan on every append.
 */
export function scanChanged(paths: string[], roots: SourceRoots): CandidateFile[] {
  const results = new Map<string, CandidateFile>();

  for (const filePath of paths) {
    const scoped = candidatesForChangedPath(filePath, roots);
    for (const candidate of scoped) {
      results.set(candidate.filePath, candidate);
    }
  }

  return [...results.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function candidatesForChangedPath(filePath: string, roots: SourceRoots): CandidateFile[] {
  const candidates: CandidateFile[] = [];

  if (roots.codex?.enabled && isInside(filePath, roots.codex.path)) {
    if (isDirSafe(filePath)) {
      walkCodex(filePath, candidates);
      return candidates;
    }
    const candidate = candidateForChangedPath(filePath, roots);
    if (candidate) {
      candidates.push(candidate);
    }
    return candidates;
  }

  if (roots.claude?.enabled && isInside(filePath, roots.claude.path)) {
    if (isDirSafe(filePath)) {
      walkClaude(filePath, candidates);
      return candidates;
    }
    const candidate = candidateForChangedPath(filePath, roots);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
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

/** Find all `*.jsonl` files under Claude projects, including nested subagent logs. */
function walkClaude(root: string, out: CandidateFile[]): void {
  walkDir(root, (filePath) => {
    if (filePath.endsWith(".jsonl")) {
      const candidate = statCandidate(filePath, "claude");
      if (candidate) {
        out.push(candidate);
      }
    }
  });
}

function candidateForChangedPath(filePath: string, roots: SourceRoots): CandidateFile | null {
  if (roots.codex?.enabled && isInside(filePath, roots.codex.path)) {
    if (isDirSafe(filePath)) {
      return null;
    }
    const name = basename(filePath);
    if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
      return statCandidate(filePath, "codex");
    }
  }

  if (roots.claude?.enabled && isInside(filePath, roots.claude.path) && filePath.endsWith(".jsonl")) {
    if (isDirSafe(filePath)) {
      return null;
    }
    return statCandidate(filePath, "claude");
  }

  return null;
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

function isInside(filePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(filePath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
