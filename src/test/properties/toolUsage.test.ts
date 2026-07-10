import * as assert from "node:assert";
import type { ToolUsageRow } from "../../shared/storeTypes";
import {
  filterToolUsage,
  formatToolSourceSummary,
  summarizeToolUsage,
} from "../../webview/toolUsage.js";

const rows: ToolUsageRow[] = [
  { toolName: "Read", source: "codex", count: 12, sharePct: 60 },
  { toolName: "Read", source: "claude", count: 5, sharePct: 25 },
  { toolName: "Bash", source: "claude", count: 3, sharePct: 15 },
];

suite("Tool usage presentation", () => {
  test("summarizes calls by source without double-counting shared tool names", () => {
    assert.deepStrictEqual(summarizeToolUsage(rows), {
      totalCalls: 20,
      codexCalls: 12,
      claudeCalls: 8,
      uniqueTools: 2,
    });
  });

  test("omits sources with zero calls from the collapsed summary", () => {
    assert.strictEqual(
      formatToolSourceSummary(summarizeToolUsage(rows.slice(0, 1))),
      "Codex 12 calls",
    );
    assert.strictEqual(
      formatToolSourceSummary(summarizeToolUsage(rows.slice(1))),
      "Claude Code 8 calls",
    );
    assert.strictEqual(formatToolSourceSummary(summarizeToolUsage([])), "");
  });

  test("keeps the same tool as separate rows when filtering by source", () => {
    assert.strictEqual(
      filterToolUsage(rows, "all").filter((row) => row.toolName === "Read").length,
      2,
    );
    assert.deepStrictEqual(filterToolUsage(rows, "codex"), [rows[0]]);
    assert.deepStrictEqual(filterToolUsage(rows, "claude"), [rows[1], rows[2]]);
  });
});
