import type { Source } from "../shared/types.js";
import type { CandidateFile } from "./discovery.js";

export interface StoredFileIdentity {
  source: Source;
  filePath: string;
  fileId: string;
}

export function dedupMigrationCanRebuild(
  recordSources: ReadonlySet<Source>,
  candidates: CandidateFile[],
): boolean {
  if (recordSources.size === 0 || candidates.length === 0) {
    return false;
  }
  const candidateSources = new Set(candidates.map((candidate) => candidate.source));
  for (const source of recordSources) {
    if (!candidateSources.has(source)) {
      return false;
    }
  }
  return true;
}

export function storedFilesCanRebuild(
  storedFiles: StoredFileIdentity[],
  candidates: CandidateFile[],
): boolean {
  if (storedFiles.length === 0 || candidates.length === 0) {
    return false;
  }

  const candidateKeys = new Set(
    candidates.map((candidate) => rebuildKey(candidate)),
  );

  return storedFiles.every((file) => candidateKeys.has(rebuildKey(file)));
}

function rebuildKey(file: StoredFileIdentity): string {
  return `${file.source}\0${file.filePath}\0${file.fileId}`;
}
