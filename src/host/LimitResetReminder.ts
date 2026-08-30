import * as vscode from "vscode";
import { LIMIT_RESET_EXPIRY_WARNING_MS } from "../shared/codexUsage";
import { localeTag, translate, type AppLanguage } from "../shared/i18n";
import type { UsageLimitReset, UsageLimitResetsInfo } from "../shared/protocol";

export const LIMIT_RESET_REMINDERS_STORAGE_KEY = "tokenWatch.limitResetReminders.v1";

export type LimitResetNotifier = (message: string) => Thenable<unknown>;

/**
 * Reminds the user about a Codex usage limit reset that is about to expire, so
 * it is not silently lost. Warns once per granted reset; the reset itself is
 * used inside Codex, this only surfaces the deadline.
 */
export class LimitResetReminder {
  private notified: string[];
  private storageQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly notify: LimitResetNotifier = (message) => vscode.window.showWarningMessage(message),
    private readonly getLanguage: () => AppLanguage = () => "en",
    private readonly now: () => number = Date.now,
  ) {
    this.notified = loadNotifiedIds(globalState.get<unknown>(LIMIT_RESET_REMINDERS_STORAGE_KEY));
  }

  /** Called after each Codex usage refresh with the resets the account has left. */
  async evaluate(limitResets?: UsageLimitResetsInfo): Promise<void> {
    const resets = limitResets?.resets;
    if (!resets) {
      return;
    }

    const now = this.now();
    const liveIds = new Set(resets.map((reset) => reset.id));
    const expiringSoon = resets.filter((reset) => isExpiringSoon(reset, now));
    const unnotified = expiringSoon.filter((reset) => !this.notified.includes(reset.id));

    // Drop resets the account no longer has, so used or expired grants stop
    // taking up storage. Ids are unique per grant, so they never come back.
    const retained = this.notified.filter((id) => liveIds.has(id));
    const nextNotified = [...retained, ...unnotified.map((reset) => reset.id)];

    const language = this.getLanguage();
    for (const reset of unnotified) {
      void this.notify(translate(language, "limitResets.expiringNotification", {
        date: formatExpiry(reset.expiresAtUtc, language),
      }));
    }

    if (nextNotified.length !== this.notified.length || unnotified.length > 0) {
      this.notified = nextNotified;
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    const snapshot = [...this.notified];
    this.storageQueue = this.storageQueue
      .then(() => this.globalState.update(LIMIT_RESET_REMINDERS_STORAGE_KEY, snapshot))
      .then(() => undefined, (error: unknown) => {
        console.warn("[TokenWatch] Failed to store usage limit reset reminders:", error);
      });
    return this.storageQueue;
  }
}

function isExpiringSoon(reset: UsageLimitReset, now: number): boolean {
  if (typeof reset.expiresAtUtc !== "number" || !Number.isFinite(reset.expiresAtUtc)) {
    return false;
  }
  const remaining = reset.expiresAtUtc - now;
  return remaining > 0 && remaining <= LIMIT_RESET_EXPIRY_WARNING_MS;
}

/** Day then time, composed separately so every locale reads date-first. */
function formatExpiry(expiresAtUtc: number | undefined, language: AppLanguage): string {
  if (typeof expiresAtUtc !== "number" || !Number.isFinite(expiresAtUtc)) {
    return "";
  }
  const locale = localeTag(language);
  const expiry = new Date(expiresAtUtc);
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(expiry);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(expiry);
  return `${day}, ${time}`;
}

function loadNotifiedIds(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}
