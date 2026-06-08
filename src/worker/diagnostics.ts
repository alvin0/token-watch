import type { Database } from "sql.js";
import type {
  DiagnosticsReport,
  FolderDayCostComparison,
  FolderDayMismatchDiagnostic,
  LongContextDiagnosticRow,
  PricingDiagnostics,
  ReconciliationMismatchDiagnostic,
} from "../shared/protocol.js";
import type { FileContribution } from "../shared/storeTypes.js";
import type { CumulativeTotals } from "../shared/types.js";
import { localDayFromMs } from "../shared/time.js";
import { LONG_CONTEXT_THRESHOLD_TOKENS, PricingEngine } from "./pricing.js";

type SqlValue = number | string | Uint8Array | null;

const MAX_DIAGNOSTIC_ROWS = 20;

export function buildDiagnosticsReport(
  db: Database,
  pricing: PricingEngine,
  pricingAudit: PricingDiagnostics,
): DiagnosticsReport {
  const folderDay = folderDayDiagnostics(db);
  return {
    generatedAtUtc: Date.now(),
    pricing: pricingAudit,
    longContext: longContextDiagnostics(db, pricing),
    crossingMidnightSessions: crossingMidnightSessions(db),
    folderDayComparison: folderDay.comparison,
    folderDayMismatches: folderDay.mismatches,
    reconciliation: reconciliationDiagnostics(db),
  };
}

function longContextDiagnostics(db: Database, pricing: PricingEngine): DiagnosticsReport["longContext"] {
  const rows = db.exec(
    `SELECT source, session_id, model,
            MAX(context_used_tokens) as max_context_used_tokens,
            COUNT(*) as turns
     FROM usage_record
     WHERE context_used_tokens IS NOT NULL
       AND context_used_tokens > ?
     GROUP BY source, session_id, model`,
    [LONG_CONTEXT_THRESHOLD_TOKENS],
  );

  const applied = new Map<string, LongContextDiagnosticRow>();
  const missingRates = new Map<string, LongContextDiagnosticRow>();

  if (rows.length > 0) {
    for (const row of rows[0].values) {
      const model = str(row[2]);
      const maxContext = num(row[3]);
      const turns = num(row[4]);
      const status = pricing.longContextStatus(model, maxContext);
      const target = status.applied ? applied : missingRates;
      const key = status.applied ? `${model}\0${status.effectiveModel}` : model;
      const existing = target.get(key);
      if (existing) {
        existing.sessions++;
        existing.turns += turns;
        existing.maxContextUsedTokens = Math.max(existing.maxContextUsedTokens, maxContext);
      } else {
        target.set(key, {
          model,
          effectiveModel: status.applied ? status.effectiveModel : undefined,
          sessions: 1,
          turns,
          maxContextUsedTokens: maxContext,
        });
      }
    }
  }

  return {
    thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
    applied: sortedRows([...applied.values()]),
    missingRates: sortedRows([...missingRates.values()]),
  };
}

function crossingMidnightSessions(db: Database): DiagnosticsReport["crossingMidnightSessions"] {
  const rows = db.exec(
    `SELECT source, session_id, workspace, first_ts_utc, last_ts_utc, total_tokens, cost_usd
     FROM session_aggregate
     ORDER BY cost_usd DESC`,
  );
  if (rows.length === 0) {
    return [];
  }

  const result: DiagnosticsReport["crossingMidnightSessions"] = [];
  for (const row of rows[0].values) {
    const firstDay = localDayFromMs(num(row[3]));
    const lastDay = localDayFromMs(num(row[4]));
    if (firstDay === lastDay) {
      continue;
    }
    result.push({
      source: sourceOf(row[0]),
      sessionId: str(row[1]),
      workspace: str(row[2]),
      firstDay,
      lastDay,
      totalTokens: num(row[5]),
      costUsd: num(row[6]),
    });
    if (result.length >= MAX_DIAGNOSTIC_ROWS) {
      break;
    }
  }
  return result;
}

function folderDayDiagnostics(db: Database): {
  comparison: FolderDayCostComparison[];
  mismatches: FolderDayMismatchDiagnostic[];
} {
  const eventCostByDay = new Map<string, number>();
  const folderCostByDay = new Map<string, number>();
  const mismatches: FolderDayMismatchDiagnostic[] = [];
  const rows = db.exec(
    `SELECT file_path, contribution
     FROM file_cursor
     WHERE source = 'codex'`,
  );

  if (rows.length > 0) {
    for (const row of rows[0].values) {
      const filePath = str(row[0]);
      const contribution = parseContribution(str(row[1]));
      const folderDay = codexFolderDay(filePath);
      if (!contribution || !folderDay) {
        continue;
      }

      let fileCost = 0;
      const eventDays = new Set<string>();
      for (const daily of contribution.daily) {
        eventDays.add(daily.day);
        fileCost += daily.costUsd;
        eventCostByDay.set(daily.day, (eventCostByDay.get(daily.day) ?? 0) + daily.costUsd);
      }
      folderCostByDay.set(folderDay, (folderCostByDay.get(folderDay) ?? 0) + fileCost);

      if ([...eventDays].some((day) => day !== folderDay)) {
        mismatches.push({
          filePath,
          folderDay,
          eventDays: [...eventDays].sort(),
          costUsd: fileCost,
        });
      }
    }
  }

  const days = new Set([...eventCostByDay.keys(), ...folderCostByDay.keys()]);
  const comparison = [...days].map((day) => {
    const eventCostUsd = eventCostByDay.get(day) ?? 0;
    const folderCostUsd = folderCostByDay.get(day) ?? 0;
    return {
      day,
      eventCostUsd,
      folderCostUsd,
      deltaUsd: eventCostUsd - folderCostUsd,
    };
  }).sort((a, b) => b.day.localeCompare(a.day));

  return {
    comparison: comparison.slice(0, MAX_DIAGNOSTIC_ROWS),
    mismatches: mismatches
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, MAX_DIAGNOSTIC_ROWS),
  };
}

function reconciliationDiagnostics(db: Database): DiagnosticsReport["reconciliation"] {
  const rows = db.exec(
    `SELECT file_path, running_totals, contribution
     FROM file_cursor
     WHERE source = 'codex'`,
  );

  let checkedSessions = 0;
  const mismatches: ReconciliationMismatchDiagnostic[] = [];

  if (rows.length > 0) {
    for (const row of rows[0].values) {
      const filePath = str(row[0]);
      const runningTotals = parseRunningTotals(str(row[1]));
      const contribution = parseContribution(str(row[2]));
      if (!runningTotals || !contribution) {
        continue;
      }

      for (const [sessionId, total] of Object.entries(runningTotals)) {
        const ingested = contribution.sessions
          .filter((session) => session.source === "codex" && session.sessionId === sessionId)
          .reduce((sum, session) => sum + rawTotalFromContribution(session.sums), 0);
        if (ingested === 0) {
          continue;
        }
        checkedSessions++;
        const finalTotal = total.inputTokens + total.outputTokens;
        const delta = ingested - finalTotal;
        if (delta !== 0) {
          mismatches.push({
            filePath,
            sessionId,
            finalTotalTokens: finalTotal,
            ingestedTotalTokens: ingested,
            deltaTokens: delta,
          });
        }
      }
    }
  }

  return {
    checkedSessions,
    mismatches: mismatches
      .sort((a, b) => Math.abs(b.deltaTokens) - Math.abs(a.deltaTokens))
      .slice(0, MAX_DIAGNOSTIC_ROWS),
  };
}

function rawTotalFromContribution(sums: CumulativeTotals): number {
  return sums.inputTokens + sums.cacheReadTokens + sums.outputTokens + sums.reasoningTokens;
}

function codexFolderDay(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]+/);
  for (let i = 0; i < parts.length - 2; i++) {
    if (/^\d{4}$/.test(parts[i]) && /^\d{2}$/.test(parts[i + 1]) && /^\d{2}$/.test(parts[i + 2])) {
      return `${parts[i]}-${parts[i + 1]}-${parts[i + 2]}`;
    }
  }
  return undefined;
}

function parseContribution(raw: string): FileContribution | undefined {
  try {
    return JSON.parse(raw) as FileContribution;
  } catch {
    return undefined;
  }
}

function parseRunningTotals(raw: string): Record<string, CumulativeTotals> | undefined {
  try {
    return JSON.parse(raw) as Record<string, CumulativeTotals>;
  } catch {
    return undefined;
  }
}

function sortedRows(rows: LongContextDiagnosticRow[]): LongContextDiagnosticRow[] {
  return rows
    .sort((a, b) => b.maxContextUsedTokens - a.maxContextUsedTokens || b.turns - a.turns)
    .slice(0, MAX_DIAGNOSTIC_ROWS);
}

function sourceOf(value: SqlValue): "codex" | "claude" {
  return value === "claude" ? "claude" : "codex";
}

function num(v: SqlValue): number {
  return typeof v === "number" ? v : 0;
}

function str(v: SqlValue): string {
  return typeof v === "string" ? v : "";
}
