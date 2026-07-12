import type { CostAlertPeriod, CostAlertRule, CostAlertSource } from "./protocol";
import type { DailyAggregate } from "./storeTypes";
import { localDay } from "./time";

export const COST_ALERT_LEVELS = [80, 95, 100] as const;
export type CostAlertLevel = typeof COST_ALERT_LEVELS[number];

export interface CostAlertAcknowledgement {
  ruleId: string;
  periodKey: string;
  level: CostAlertLevel;
}

export interface PendingCostAlert {
  rule: CostAlertRule;
  periodKey: string;
  level: CostAlertLevel;
  costUsd: number;
  unknownCostTurns: number;
}

export function validateCostAlertRules(value: unknown): CostAlertRule[] {
  if (!Array.isArray(value)) {
    throw new Error("Cost alert settings must be an array.");
  }

  const ids = new Set<string>();
  const budgets = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Alert ${index + 1} is invalid.`);
    }
    const rule = candidate as Partial<CostAlertRule>;
    const id = typeof rule.id === "string" ? rule.id.trim() : "";
    if (!id || id.length > 128 || !/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error(`Alert ${index + 1} has an invalid ID.`);
    }
    if (ids.has(id)) {
      throw new Error("Alert IDs must be unique.");
    }
    ids.add(id);

    if (!isCostAlertPeriod(rule.period)) {
      throw new Error(`Alert ${index + 1} has an invalid period.`);
    }
    const source = rule.source === undefined ? "all" : rule.source;
    if (!isCostAlertSource(source)) {
      throw new Error(`Alert ${index + 1} has an invalid source.`);
    }
    if (typeof rule.budgetUsd !== "number" || !Number.isFinite(rule.budgetUsd) || rule.budgetUsd <= 0) {
      throw new Error(`Alert ${index + 1} must have a budget greater than $0.`);
    }

    const budgetKey = `${source}:${rule.period}:${rule.budgetUsd}`;
    if (budgets.has(budgetKey)) {
      throw new Error("Two alerts cannot use the same source, period, and budget.");
    }
    budgets.add(budgetKey);
    return { id, period: rule.period, source, budgetUsd: rule.budgetUsd };
  });
}

export function isCostAlertPeriod(value: unknown): value is CostAlertPeriod {
  return value === "day" || value === "week" || value === "month";
}

export function isCostAlertSource(value: unknown): value is CostAlertSource {
  return value === "all" || value === "codex" || value === "claude";
}

export function periodStart(period: CostAlertPeriod, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  } else if (period === "month") {
    start.setDate(1);
  }
  return start;
}

export function periodKey(period: CostAlertPeriod, now: Date): string {
  const start = periodStart(period, now);
  return period === "month" ? localDay(start).slice(0, 7) : localDay(start);
}

export function earliestPeriodStart(rules: CostAlertRule[], now: Date): Date {
  let earliest = now;
  for (const rule of rules) {
    const start = periodStart(rule.period, now);
    if (start.getTime() < earliest.getTime()) {
      earliest = start;
    }
  }
  return earliest;
}

export function pendingCostAlerts(
  rules: CostAlertRule[],
  series: DailyAggregate[],
  acknowledgements: CostAlertAcknowledgement[],
  now: Date,
): PendingCostAlert[] {
  const acknowledged = new Set(acknowledgements.map(acknowledgementKey));
  return rules.flatMap((rule) => {
    const startDay = localDay(periodStart(rule.period, now));
    let costUsd = 0;
    let unknownCostTurns = 0;
    for (const row of series) {
      if (row.day >= startDay && (rule.source === "all" || row.source === rule.source)) {
        costUsd += row.costUsd;
        unknownCostTurns += row.unknownCostTurns;
      }
    }

    const key = periodKey(rule.period, now);
    const level = [...COST_ALERT_LEVELS]
      .reverse()
      .find((candidate) =>
        costUsd >= rule.budgetUsd * candidate / 100 &&
        !acknowledged.has(acknowledgementKey({ ruleId: rule.id, periodKey: key, level: candidate })),
      );
    return level === undefined ? [] : [{ rule, periodKey: key, level, costUsd, unknownCostTurns }];
  });
}

export function acknowledgeThrough(
  acknowledgements: CostAlertAcknowledgement[],
  alert: PendingCostAlert,
): CostAlertAcknowledgement[] {
  const result = new Map(acknowledgements.map((item) => [acknowledgementKey(item), item]));
  for (const level of COST_ALERT_LEVELS) {
    if (level <= alert.level) {
      const item: CostAlertAcknowledgement = { ruleId: alert.rule.id, periodKey: alert.periodKey, level };
      result.set(acknowledgementKey(item), item);
    }
  }
  return Array.from(result.values());
}

export function pruneAcknowledgements(
  rules: CostAlertRule[],
  acknowledgements: CostAlertAcknowledgement[],
  now: Date,
): CostAlertAcknowledgement[] {
  const activePeriods = new Map(rules.map((rule) => [rule.id, periodKey(rule.period, now)]));
  const seen = new Set<string>();
  return acknowledgements.filter((item) => {
    const key = acknowledgementKey(item);
    if (seen.has(key) || activePeriods.get(item.ruleId) !== item.periodKey || !COST_ALERT_LEVELS.includes(item.level)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function acknowledgementKey(item: CostAlertAcknowledgement): string {
  return `${item.ruleId}:${item.periodKey}:${item.level}`;
}
