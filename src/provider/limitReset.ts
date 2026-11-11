/**
 * A usage limit reset activation that certainly did not spend a reset: it
 * failed before the claim was sent, or the server answered and refused it.
 *
 * Any other failure — a timeout, a dropped connection, a 5xx, an answer that
 * cannot be read — leaves open whether the server applied the claim, and the
 * caller has to re-read the account before the user tries again.
 */
export class LimitResetNotSpentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitResetNotSpentError";
  }
}

export function isLimitResetNotSpent(error: unknown): error is LimitResetNotSpentError {
  return error instanceof LimitResetNotSpentError;
}
