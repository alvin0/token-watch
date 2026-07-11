export const MIN_USAGE_RETRY_MS = 75_000;
export const MAX_USAGE_RETRY_MS = 135_000;

export function randomUsageRetryMs(random = Math.random): number {
  return Math.floor(MIN_USAGE_RETRY_MS + random() * (MAX_USAGE_RETRY_MS - MIN_USAGE_RETRY_MS + 1));
}
