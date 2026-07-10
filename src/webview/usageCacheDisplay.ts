const usageTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

export function formatUsageTime(prefix: string, timestamp: number | undefined): string | undefined {
  if (!isFiniteNumber(timestamp)) { return undefined; }
  return `${prefix} ${usageTimeFormatter.format(new Date(timestamp))}`;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
