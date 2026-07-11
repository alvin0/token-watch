import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { recentLocalDays } from "../lib/dayUsageTrend";
import { useStore } from "../store";
import { HourlyUsageTrendCard } from "./TodayUsageTrend";

export function DayUsageTrend() {
  const [dayIndex, setDayIndex] = useState(6);
  const days = useMemo(() => recentLocalDays(), []);
  const day = days[dayIndex];
  const rows = useStore((s) => s.dailyHourlySeries);
  const pending = useStore((s) => s.dailyHourlyPending);
  const error = useStore((s) => s.dailyHourlyError);
  const requestDailyHourly = useStore((s) => s.requestDailyHourly);
  const clearDailyHourly = useStore((s) => s.clearDailyHourly);
  const sources = useStore((s) => s.sources);
  const models = useStore((s) => s.models);
  const efforts = useStore((s) => s.efforts);
  const workspaces = useStore((s) => s.workspaces);
  const rollupToBaseModel = useStore((s) => s.rollupToBaseModel);
  const breakdownByVariant = useStore((s) => s.breakdownByVariant);
  const { locale, t } = useTranslation();

  useEffect(() => {
    requestDailyHourly(day);
  }, [day, sources, models, efforts, workspaces, rollupToBaseModel, breakdownByVariant, requestDailyHourly]);

  useEffect(() => clearDailyHourly, [clearDailyHourly]);

  const dateLabel = new Date(`${day}T12:00:00`).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const navigation = (
    <div className="tw-flex tw-items-center tw-gap-1">
      <button type="button" aria-label={t("trend.previousDay")} title={t("trend.previousDay")}
        disabled={dayIndex === 0} onClick={() => setDayIndex((index) => Math.max(0, index - 1))}
        className="tw-h-5 tw-w-5 tw-cursor-pointer tw-rounded tw-bg-[#0d0d1a] tw-text-[10px] disabled:tw-cursor-default disabled:tw-opacity-40">&lt;</button>
      <button type="button" aria-label={t("trend.nextDay")} title={t("trend.nextDay")}
        disabled={dayIndex === days.length - 1} onClick={() => setDayIndex((index) => Math.min(days.length - 1, index + 1))}
        className="tw-h-5 tw-w-5 tw-cursor-pointer tw-rounded tw-bg-[#0d0d1a] tw-text-[10px] disabled:tw-cursor-default disabled:tw-opacity-40">&gt;</button>
    </div>
  );

  return <HourlyUsageTrendCard rows={rows} day={day} title={t("trend.detailByDay")}
    subtitle={(peak) => t("trend.hourlyDayPeak", { date: dateLabel, peak })}
    navigation={navigation} pending={pending} error={error} />;
}
