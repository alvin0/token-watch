import * as vscode from "vscode";
import type { AnalyticsQuery, AnalyticsResult, CostAlertRule, FreshnessInfo } from "../shared/protocol";
import { translate, type AppLanguage } from "../shared/i18n";
import {
  acknowledgeThrough,
  earliestPeriodStart,
  pendingCostAlerts,
  periodKey,
  pruneAcknowledgements,
  validateCostAlertRules,
  type CostAlertAcknowledgement,
  type PendingCostAlert,
} from "../shared/costAlerts";

export const COST_ALERT_RULES_STORAGE_KEY = "tokenWatch.costAlerts.rules.v1";
export const COST_ALERT_ACKS_STORAGE_KEY = "tokenWatch.costAlerts.acknowledgements.v1";
const STORAGE_VERSION = 1;
const EVALUATION_INVALIDATED = Symbol("evaluation-invalidated");

export interface CostAlertCoordinator {
  query(query: AnalyticsQuery): Promise<AnalyticsResult>;
  onScanComplete(listener: (freshness: FreshnessInfo) => unknown): vscode.Disposable;
}

interface StoredRules {
  version: 1;
  rules: CostAlertRule[];
}

interface StoredAcknowledgements {
  version: 1;
  acknowledgements: CostAlertAcknowledgement[];
}

export type CostAlertNotifier = (message: string, action: string) => Thenable<string | undefined>;

export class CostAlertController implements vscode.Disposable {
  private rules: CostAlertRule[];
  private acknowledgements: CostAlertAcknowledgement[];
  private readonly disposables: vscode.Disposable[] = [];
  private evaluationPromise: Promise<void> | undefined;
  private evaluationQueued = false;
  private rulesRevision = 0;
  private evaluationInvalidated: Promise<typeof EVALUATION_INVALIDATED>;
  private invalidateEvaluation: () => void = () => undefined;
  private storageQueue: Promise<void> = Promise.resolve();
  private started = false;
  private disposed = false;

  constructor(
    private readonly coordinator: CostAlertCoordinator,
    private readonly globalState: vscode.Memento,
    private readonly notify: CostAlertNotifier = (message, action) => vscode.window.showWarningMessage(message, action),
    private readonly getLanguage: () => AppLanguage = () => "en",
  ) {
    this.evaluationInvalidated = this.createEvaluationInvalidation();
    this.rules = loadRules(globalState.get<unknown>(COST_ALERT_RULES_STORAGE_KEY));
    this.acknowledgements = loadAcknowledgements(globalState.get<unknown>(COST_ALERT_ACKS_STORAGE_KEY));
  }

  start(): void {
    if (this.started || this.disposed) { return; }
    this.started = true;
    this.disposables.push(this.coordinator.onScanComplete(() => {
      void this.evaluateNow();
    }));
    void this.evaluateNow();
  }

  getRules(): CostAlertRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  async saveRules(value: unknown): Promise<CostAlertRule[]> {
    const nextRules = validateCostAlertRules(value);
    this.invalidateEvaluation();
    this.evaluationInvalidated = this.createEvaluationInvalidation();
    this.rulesRevision++;
    const previousRules = new Map(this.rules.map((rule) => [rule.id, rule]));
    const unchangedIds = new Set(nextRules.flatMap((rule) => {
      const previous = previousRules.get(rule.id);
      return previous && previous.period === rule.period && previous.source === rule.source && previous.budgetUsd === rule.budgetUsd ? [rule.id] : [];
    }));

    const nextAcknowledgements = pruneAcknowledgements(
      nextRules,
      this.acknowledgements.filter((item) => unchangedIds.has(item.ruleId)),
      new Date(),
    );
    await this.enqueueStorageWrite(async () => {
      await this.globalState.update(COST_ALERT_RULES_STORAGE_KEY, {
        version: STORAGE_VERSION,
        rules: nextRules,
      } satisfies StoredRules);
      await this.globalState.update(COST_ALERT_ACKS_STORAGE_KEY, {
        version: STORAGE_VERSION,
        acknowledgements: nextAcknowledgements,
      } satisfies StoredAcknowledgements);
    });
    this.rules = nextRules;
    this.acknowledgements = nextAcknowledgements;
    void this.evaluateNow();
    return this.getRules();
  }

  evaluateNow(): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    if (this.evaluationPromise) {
      this.evaluationQueued = true;
      return this.evaluationPromise;
    }

    const promise = this.runEvaluation()
      .catch((error) => {
        if (!this.disposed) {
          console.error("[TokenWatch] cost alert evaluation failed:", error);
        }
      })
      .finally(() => {
        this.evaluationPromise = undefined;
        if (this.evaluationQueued && !this.disposed) {
          this.evaluationQueued = false;
          void this.evaluateNow();
        }
      });
    this.evaluationPromise = promise;
    return promise;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.invalidateEvaluation();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async runEvaluation(): Promise<void> {
    const revision = this.rulesRevision;
    const invalidated = this.evaluationInvalidated;
    const now = new Date();
    const pruned = pruneAcknowledgements(this.rules, this.acknowledgements, now);
    if (pruned.length !== this.acknowledgements.length) {
      this.acknowledgements = pruned;
      await this.persistAcknowledgements();
    }
    if (this.rules.length === 0) { return; }

    const rulesSnapshot = this.getRules();
    const result = await Promise.race([this.coordinator.query({
      view: "series",
      granularity: "day",
      range: { fromUtc: earliestPeriodStart(rulesSnapshot, now).getTime(), toUtc: now.getTime() },
    }), invalidated]);
    if (result === EVALUATION_INVALIDATED || this.disposed || revision !== this.rulesRevision || result.view !== "series") { return; }

    const alerts = pendingCostAlerts(rulesSnapshot, result.series, this.acknowledgements, now);
    for (const alert of alerts) {
      if (this.disposed || revision !== this.rulesRevision) { return; }
      if (!this.ruleStillMatches(alert)) { continue; }
      const language = this.getLanguage();
      const confirmAction = translate(language, "common.confirm");
      const action = await Promise.race([
        this.notify(formatAlertMessage(alert, language), confirmAction),
        invalidated,
      ]);
      if (action === EVALUATION_INVALIDATED) { return; }
      if (action === confirmAction && revision === this.rulesRevision && this.ruleStillMatches(alert) && periodKey(alert.rule.period, new Date()) === alert.periodKey) {
        this.acknowledgements = acknowledgeThrough(this.acknowledgements, alert);
        await this.persistAcknowledgements();
      }
    }
  }

  private ruleStillMatches(alert: PendingCostAlert): boolean {
    return this.rules.some((rule) =>
      rule.id === alert.rule.id && rule.period === alert.rule.period && rule.source === alert.rule.source && rule.budgetUsd === alert.rule.budgetUsd,
    );
  }

  private persistAcknowledgements(): Promise<void> {
    return this.enqueueStorageWrite(() => this.globalState.update(COST_ALERT_ACKS_STORAGE_KEY, {
      version: STORAGE_VERSION,
      acknowledgements: this.acknowledgements,
    } satisfies StoredAcknowledgements));
  }

  private enqueueStorageWrite(write: () => Thenable<void> | Promise<void>): Promise<void> {
    const queued = this.storageQueue.then(write);
    this.storageQueue = queued.catch(() => undefined);
    return queued;
  }

  private createEvaluationInvalidation(): Promise<typeof EVALUATION_INVALIDATED> {
    return new Promise((resolve) => {
      this.invalidateEvaluation = () => resolve(EVALUATION_INVALIDATED);
    });
  }
}

function loadRules(value: unknown): CostAlertRule[] {
  if (!value || typeof value !== "object" || (value as Partial<StoredRules>).version !== STORAGE_VERSION) {
    return [];
  }
  try {
    return validateCostAlertRules((value as StoredRules).rules);
  } catch {
    return [];
  }
}

function loadAcknowledgements(value: unknown): CostAlertAcknowledgement[] {
  if (!value || typeof value !== "object" || (value as Partial<StoredAcknowledgements>).version !== STORAGE_VERSION) {
    return [];
  }
  const items = (value as StoredAcknowledgements).acknowledgements;
  if (!Array.isArray(items)) { return []; }
  return items.filter((item): item is CostAlertAcknowledgement =>
    Boolean(item) && typeof item.ruleId === "string" && typeof item.periodKey === "string" &&
    (item.level === 80 || item.level === 95 || item.level === 100),
  );
}

function formatAlertMessage(alert: PendingCostAlert, language: AppLanguage): string {
  const periodKey = alert.rule.period === "day" ? "alerts.daily" : alert.rule.period === "week" ? "alerts.weekly" : "alerts.monthly";
  const sourceKey = alert.rule.source === "codex" ? "alerts.sourceCodex" : alert.rule.source === "claude" ? "alerts.sourceClaude" : "alerts.sourceAll";
  const message = translate(language, "alerts.notification", {
    source: translate(language, sourceKey),
    period: translate(language, periodKey),
    level: alert.level,
    cost: formatUsd(alert.costUsd),
    budget: formatUsd(alert.rule.budgetUsd),
  });
  return message + (alert.unknownCostTurns > 0 ? translate(language, "alerts.unknownPrice") : "");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
