export function formatUsageTime(prefix: string, timestamp: number | undefined, locale = "en-US"): string | undefined {
  if (!isFiniteNumber(timestamp)) { return undefined; }
  return `${prefix} ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp))}`;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
