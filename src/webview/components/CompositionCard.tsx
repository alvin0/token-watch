import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { computePeriods, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useTranslation } from "../i18n";
import { chartColors } from "../theme";

export function CompositionCard() {
  const result = useQuery("dashboard");
  const g = useStore((s) => s.granularity) as Period;
  const { t } = useTranslation();
  if (!result || result.view !== "dashboard") { return null; }
  const { cur } = computePeriods(result.series, g);
  const { input, output, cache, reasoning } = cur;
  const total = input + output + cache + reasoning;
  if (total === 0) { return null; }

  const cachePct = cache / total;
  const insight = cachePct > 0.5 ? t("composition.highCache")
    : cachePct < 0.1 ? t("composition.lowCache")
    : reasoning / total > 0.1 ? t("composition.highReasoning")
    : t("composition.balanced");

  return (
    <div className="tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-p-3">
      <div className="tw-text-[10px] tw-font-medium tw-mb-1.5">{t("composition.title")}</div>
      <div className="tw-flex tw-h-[6px] tw-rounded-full tw-overflow-hidden tw-mb-2">
        {input > 0 && <div style={{ flex: input, backgroundColor: chartColors.input }} />}
        {output > 0 && <div style={{ flex: output, backgroundColor: chartColors.output }} />}
        {cache > 0 && <div style={{ flex: cache, backgroundColor: chartColors.cacheRead }} />}
        {reasoning > 0 && <div style={{ flex: reasoning, backgroundColor: chartColors.reasoning }} />}
      </div>
      <div className="tw-flex tw-justify-between tw-text-[9px]">
        <Dot color={chartColors.input} label={t("common.input")} value={fmtT(input)} />
        <Dot color={chartColors.output} label={t("common.output")} value={fmtT(output)} />
        <Dot color={chartColors.cacheRead} label={t("common.cache")} value={fmtT(cache)} />
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
    <div className="tw-text-center">
      <div className="tw-flex tw-items-center tw-justify-center tw-gap-0.5">
        <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full" style={{ backgroundColor: color }} />
        <span className="tw-text-[var(--vscode-descriptionForeground)]">{label}</span>
      </div>
      <div className="tw-font-semibold tw-text-[var(--vscode-foreground)] tw-tabular-nums">{value}</div>
    </div>
  );
}
