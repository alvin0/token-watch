import type { ToolUsageRow } from "../shared/storeTypes";
import type { Source } from "../shared/types";

export type ToolSourceFilter = "all" | Source;

export interface ToolUsageSummary {
  totalCalls: number;
  codexCalls: number;
  claudeCalls: number;
  uniqueTools: number;
}

export function summarizeToolUsage(rows: ToolUsageRow[]): ToolUsageSummary {
  let codexCalls = 0;
  let claudeCalls = 0;

  for (const row of rows) {
    if (row.source === "codex") {
      codexCalls += row.count;
    } else {
      claudeCalls += row.count;
    }
  }

  return {
    totalCalls: codexCalls + claudeCalls,
    codexCalls,
    claudeCalls,
    uniqueTools: new Set(rows.map((row) => row.toolName)).size,
  };
}

export function formatToolSourceSummary(summary: ToolUsageSummary): string {
  const sources: string[] = [];
  if (summary.codexCalls > 0) {
    sources.push(`Codex ${summary.codexCalls.toLocaleString()} calls`);
  }
  if (summary.claudeCalls > 0) {
    sources.push(`Claude Code ${summary.claudeCalls.toLocaleString()} calls`);
  }
  return sources.join(" · ");
}

export function filterToolUsage(
  rows: ToolUsageRow[],
  source: ToolSourceFilter,
): ToolUsageRow[] {
  return source === "all" ? rows : rows.filter((row) => row.source === source);
}

export function toolSourceLabel(source: Source): string {
  return source === "codex" ? "Codex" : "Claude Code";
}
