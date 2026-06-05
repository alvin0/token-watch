import type { Source } from "../shared/types.js";
import type { CandidateFile } from "./discovery.js";

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
