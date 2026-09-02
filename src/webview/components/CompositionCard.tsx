import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";
import { chartColors } from "../theme";

export function CompositionCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { locale, t } = useTranslation();
  if (!result || result.view !== "dashboard") { return null; }
  const { cur } = computePeriods(result.series, g, locale);
  // All five components, so the bar and the numbers add up to the period total.
  const { input, output, cacheRead, cacheWrite, reasoning, breakdownTotal } = cur.metrics;
  if (breakdownTotal === 0) { return null; }

  const cachePct = (cacheRead + cacheWrite) / breakdownTotal;
  const insight = cachePct > 0.5 ? t("composition.highCache")
    : cachePct < 0.1 ? t("composition.lowCache")
    : reasoning / breakdownTotal > 0.1 ? t("composition.highReasoning")
    : t("composition.balanced");

  return (
    <div className="tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-p-3">
      <div className="tw-text-[10px] tw-font-medium tw-mb-1.5">{t("composition.title")}</div>
      <div className="tw-flex tw-h-[6px] tw-rounded-full tw-overflow-hidden tw-mb-2">
        {input > 0 && <div style={{ flex: input, backgroundColor: chartColors.input }} />}
        {output > 0 && <div style={{ flex: output, backgroundColor: chartColors.output }} />}
        {cacheRead > 0 && <div style={{ flex: cacheRead, backgroundColor: chartColors.cacheRead }} />}
        {cacheWrite > 0 && <div style={{ flex: cacheWrite, backgroundColor: chartColors.cacheCreation }} />}
        {reasoning > 0 && <div style={{ flex: reasoning, backgroundColor: chartColors.reasoning }} />}
      </div>
      <div className="tw-flex tw-justify-between tw-gap-1 tw-text-[9px]">
        <Dot color={chartColors.input} label={t("common.input")} value={fmtT(input)} />
        <Dot color={chartColors.output} label={t("common.output")} value={fmtT(output)} />
        <Dot color={chartColors.cacheRead} label={t("common.cacheRead")} value={fmtT(cacheRead)} />
        <Dot color={chartColors.cacheCreation} label={t("common.cacheWrite")} value={fmtT(cacheWrite)} />
        <Dot color={chartColors.reasoning} label={t("common.reasoning")} value={fmtT(reasoning)} />
      </div>
      <div className="tw-mt-1.5 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)] tw-flex tw-items-center tw-gap-1">
        <span className="tw-text-chart-green">✓</span>{insight}
      </div>
    </div>
  );
}

function Dot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="tw-min-w-0 tw-text-center">
      <div className="tw-flex tw-items-center tw-justify-center tw-gap-0.5">
        <span className="tw-w-[5px] tw-h-[5px] tw-shrink-0 tw-rounded-full" style={{ backgroundColor: color }} />
        <span className="tw-truncate tw-text-[var(--vscode-descriptionForeground)]" title={label}>{label}</span>
      </div>
      <div className="tw-font-semibold tw-text-[var(--vscode-foreground)] tw-tabular-nums">{value}</div>
    </div>
  );
}
