import type { Source } from "../../shared/types.js";

export const CODEX_PARSE_REVISION = 1;
export const CLAUDE_PARSE_REVISION = 1;

export function parseRevisionForSource(source: Source): number {
  return source === "codex" ? CODEX_PARSE_REVISION : CLAUDE_PARSE_REVISION;
}
