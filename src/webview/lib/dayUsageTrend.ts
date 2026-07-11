import { localDay } from "../../shared/time";

export function recentLocalDays(now = new Date(), count = 7): string[] {
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    days.push(localDay(date));
  }
  return days;
}
