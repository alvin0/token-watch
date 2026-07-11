import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  COST_ALERT_LEVELS,
  acknowledgeThrough,
  earliestPeriodStart,
  pendingCostAlerts,
  periodKey,
  periodStart,
  pruneAcknowledgements,
  validateCostAlertRules,
  type CostAlertAcknowledgement,
} from "../../shared/costAlerts.js";
import type { AnalyticsQuery, AnalyticsResult, CostAlertRule } from "../../shared/protocol.js";
import type { DailyAggregate } from "../../shared/storeTypes.js";
import { localDay } from "../../shared/time.js";
import {
  COST_ALERT_ACKS_STORAGE_KEY,
  COST_ALERT_RULES_STORAGE_KEY,
  CostAlertController,
  type CostAlertCoordinator,
} from "../../host/CostAlertController.js";

suite("Cost threshold alerts", () => {
  test("validates positive budgets, IDs, periods, and duplicate period/budget pairs", () => {
    assert.deepStrictEqual(validateCostAlertRules([
      { id: "daily-1", period: "day", budgetUsd: 10 },
      { id: "weekly-1", period: "week", budgetUsd: 10 },
    ]), [
      { id: "daily-1", period: "day", budgetUsd: 10 },
      { id: "weekly-1", period: "week", budgetUsd: 10 },
    ]);

    assert.throws(() => validateCostAlertRules([{ id: "bad id", period: "day", budgetUsd: 10 }]), /invalid ID/);
    assert.throws(() => validateCostAlertRules([{ id: "bad-budget", period: "day", budgetUsd: 0 }]), /greater than/);
    assert.throws(() => validateCostAlertRules([{ id: "bad-period", period: "year", budgetUsd: 10 }]), /invalid period/);
    assert.throws(() => validateCostAlertRules([
      { id: "one", period: "month", budgetUsd: 25 },
      { id: "two", period: "month", budgetUsd: 25 },
    ]), /same period and budget/);
  });

  test("uses local calendar day, Monday week, and calendar month boundaries", () => {
    const wednesday = new Date(2026, 6, 15, 14, 30);
    assert.strictEqual(localDay(periodStart("day", wednesday)), "2026-07-15");
    assert.strictEqual(localDay(periodStart("week", wednesday)), "2026-07-13");
    assert.strictEqual(localDay(periodStart("month", wednesday)), "2026-07-01");
    assert.strictEqual(periodKey("day", wednesday), "2026-07-15");
    assert.strictEqual(periodKey("week", wednesday), "2026-07-13");
    assert.strictEqual(periodKey("month", wednesday), "2026-07");

    const earliest = earliestPeriodStart([
      { id: "day", period: "day", budgetUsd: 1 },
      { id: "month", period: "month", budgetUsd: 1 },
    ], wednesday);
    assert.strictEqual(localDay(earliest), "2026-07-01");
  });

  test("emits 80, 95, and 100 percent alerts at exact boundaries", () => {
    const now = new Date(2026, 6, 15, 12);
    const rule: CostAlertRule = { id: "daily", period: "day", budgetUsd: 10 };
    let acknowledgements: CostAlertAcknowledgement[] = [];

    let alerts = pendingCostAlerts([rule], [dailyRow(now, 8)], acknowledgements, now);
    assert.strictEqual(alerts[0].level, 80);
    acknowledgements = acknowledgeThrough(acknowledgements, alerts[0]);

    alerts = pendingCostAlerts([rule], [dailyRow(now, 9.5)], acknowledgements, now);
    assert.strictEqual(alerts[0].level, 95);
    acknowledgements = acknowledgeThrough(acknowledgements, alerts[0]);

    alerts = pendingCostAlerts([rule], [dailyRow(now, 10, 2)], acknowledgements, now);
    assert.strictEqual(alerts[0].level, 100);
    assert.strictEqual(alerts[0].unknownCostTurns, 2);
  });

  test("a jump shows only the highest level and confirming it acknowledges lower levels", () => {
    const now = new Date(2026, 6, 15, 12);
    const rule: CostAlertRule = { id: "daily", period: "day", budgetUsd: 10 };
    const alert = pendingCostAlerts([rule], [dailyRow(now, 12)], [], now)[0];
    assert.strictEqual(alert.level, 100);
    assert.deepStrictEqual(
      acknowledgeThrough([], alert).map((item) => item.level),
      [...COST_ALERT_LEVELS],
    );
  });

  test("prunes deleted rules, duplicate acknowledgements, and previous periods", () => {
    const now = new Date(2026, 6, 15, 12);
    const rule: CostAlertRule = { id: "daily", period: "day", budgetUsd: 10 };
    const current = { ruleId: "daily", periodKey: "2026-07-15", level: 80 as const };
    assert.deepStrictEqual(pruneAcknowledgements([rule], [
      current,
      current,
      { ruleId: "daily", periodKey: "2026-07-14", level: 95 },
      { ruleId: "deleted", periodKey: "2026-07-15", level: 100 },
    ], now), [current]);
  });

  test("controller does not query when no rules are configured", async () => {
    const coordinator = new FakeCoordinator([]);
    const controller = new CostAlertController(coordinator, new MemoryMemento() as unknown as vscode.Memento);
    await controller.evaluateNow();
    assert.strictEqual(coordinator.queryCount, 0);
    controller.dispose();
  });

  test("Confirm persists the reached level while dismiss leaves it unacknowledged", async () => {
    const now = new Date();
    const rule: CostAlertRule = { id: "daily", period: "day", budgetUsd: 10 };

    const confirmedState = seededState([rule]);
    const confirmedMessages: string[] = [];
    const confirmed = new CostAlertController(
      new FakeCoordinator([dailyRow(now, 9.5)]),
      confirmedState as unknown as vscode.Memento,
      async (message) => { confirmedMessages.push(message); return "Confirm"; },
    );
    await confirmed.evaluateNow();
    const stored = confirmedState.get<{ acknowledgements: CostAlertAcknowledgement[] }>(COST_ALERT_ACKS_STORAGE_KEY);
    assert.deepStrictEqual(stored?.acknowledgements.map((item) => item.level), [80, 95]);
    assert.ok(confirmedMessages[0].includes("reached 95%"));
    confirmed.dispose();

    let reloadedNotifications = 0;
    const reloaded = new CostAlertController(
      new FakeCoordinator([dailyRow(now, 9.5)]),
      confirmedState as unknown as vscode.Memento,
      async () => { reloadedNotifications++; return undefined; },
    );
    await reloaded.evaluateNow();
    assert.strictEqual(reloadedNotifications, 0, "confirmed levels should stay silent after reload");
    reloaded.dispose();

    const dismissedState = seededState([rule]);
    const dismissed = new CostAlertController(
      new FakeCoordinator([dailyRow(now, 8)]),
      dismissedState as unknown as vscode.Memento,
      async () => undefined,
    );
    await dismissed.evaluateNow();
    assert.strictEqual(dismissedState.get(COST_ALERT_ACKS_STORAGE_KEY), undefined);
    dismissed.dispose();
  });

  test("editing a rule clears its acknowledgements", async () => {
    const now = new Date();
    const state = seededState(
      [{ id: "daily", period: "day", budgetUsd: 10 }],
      [{ ruleId: "daily", periodKey: periodKey("day", now), level: 80 }],
    );
    const controller = new CostAlertController(new FakeCoordinator([]), state as unknown as vscode.Memento);
    await controller.saveRules([{ id: "daily", period: "day", budgetUsd: 20 }]);
    const stored = state.get<{ acknowledgements: CostAlertAcknowledgement[] }>(COST_ALERT_ACKS_STORAGE_KEY);
    assert.deepStrictEqual(stored?.acknowledgements, []);
    controller.dispose();
  });

  test("uses the selected language for native notifications and confirmation", async () => {
    const now = new Date();
    let notification = "";
    let actionLabel = "";
    const controller = new CostAlertController(
      new FakeCoordinator([dailyRow(now, 8)]),
      seededState([{ id: "daily", period: "day", budgetUsd: 10 }]) as unknown as vscode.Memento,
      async (message, action) => {
        notification = message;
        actionLabel = action;
        return undefined;
      },
      () => "vi",
    );

    await controller.evaluateNow();
    assert.ok(notification.includes("Chi phí Hàng ngày đã đạt 80%"));
    assert.strictEqual(actionLabel, "Xác nhận");
    controller.dispose();
  });

  test("coalesces overlapping evaluations into one active and one trailing query", async () => {
    const now = new Date();
    let releaseFirst: ((result: AnalyticsResult) => void) | undefined;
    const coordinator = new FakeCoordinator([dailyRow(now, 0)], () => {
      if (coordinator.queryCount === 1) {
        return new Promise<AnalyticsResult>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve({ view: "series", series: [] });
    });
    const controller = new CostAlertController(
      coordinator,
      seededState([{ id: "daily", period: "day", budgetUsd: 10 }]) as unknown as vscode.Memento,
    );

    const first = controller.evaluateNow();
    void controller.evaluateNow();
    void controller.evaluateNow();
    assert.strictEqual(coordinator.queryCount, 1);
    assert.ok(releaseFirst);
    releaseFirst({ view: "series", series: [] });
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(coordinator.queryCount, 2);
    controller.dispose();
  });
});

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }
}

class FakeCoordinator implements CostAlertCoordinator {
  readonly scanComplete = new vscode.EventEmitter<never>();
  readonly onScanComplete = this.scanComplete.event;
  queryCount = 0;

  constructor(
    private readonly series: DailyAggregate[],
    private readonly queryImplementation?: (query: AnalyticsQuery) => Promise<AnalyticsResult>,
  ) {}

  query(query: AnalyticsQuery): Promise<AnalyticsResult> {
    this.queryCount++;
    return this.queryImplementation?.(query) ?? Promise.resolve({ view: "series", series: this.series });
  }
}

function seededState(rules: CostAlertRule[], acknowledgements?: CostAlertAcknowledgement[]): MemoryMemento {
  const state = new MemoryMemento();
  void state.update(COST_ALERT_RULES_STORAGE_KEY, { version: 1, rules });
  if (acknowledgements) {
    void state.update(COST_ALERT_ACKS_STORAGE_KEY, { version: 1, acknowledgements });
  }
  return state;
}

function dailyRow(now: Date, costUsd: number, unknownCostTurns = 0): DailyAggregate {
  return {
    day: localDay(now),
    source: "codex",
    variantId: "gpt-5",
    baseModel: "gpt-5",
    workspace: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 1,
    costUsd,
    unknownCostTurns,
  };
}
