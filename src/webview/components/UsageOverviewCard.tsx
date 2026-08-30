interface UsageOverviewCardProps {
  title: string;
  cost: string;
  comparisonCost: string;
  delta: number;
  comparisonLabel: string;
  totalTokens: string;
  cachedTokens: string;
  inputTokens: string;
  outputTokens: string;
  cacheHitPct: number;
  turns: string;
  toolCalls: string;
  models: string;
  costPerTurn: string;
}

const THREE_COLUMN_GRID = { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" };
const FOUR_COLUMN_GRID = { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" };

export function UsageOverviewCard({
  title,
  cost,
  comparisonCost,
  delta,
  comparisonLabel,
  totalTokens,
  cachedTokens,
  inputTokens,
  outputTokens,
  cacheHitPct,
  turns,
  toolCalls,
  models,
  costPerTurn,
}: UsageOverviewCardProps) {
  const { t } = useTranslation();
  const deltaTone = delta === 0 ? "tw-text-chart-yellow" : delta < 0 ? "tw-text-chart-red" : "tw-text-chart-green";
  const deltaArrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";

  return (
    <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-edge tw-bg-card">
      <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-p-3">
        <div className="tw-min-w-0">
          <div className="tw-truncate tw-text-[10px] tw-font-medium tw-text-[var(--vscode-descriptionForeground)]">
            {title}
          </div>
          <div className="tw-mt-1 tw-text-[28px] tw-font-bold tw-leading-none tw-tabular-nums tw-text-[var(--vscode-foreground)]">
            {cost}
          </div>
        </div>

        <div className={`tw-shrink-0 tw-text-right ${deltaTone}`}>
          <div className="tw-text-[13px] tw-font-semibold tw-tabular-nums">
            {deltaArrow} {Math.abs(delta).toFixed(1)}%
          </div>
          <div className="tw-mt-0.5 tw-text-[8px] tw-tabular-nums">
            {t("overview.vs", { cost: comparisonCost, period: comparisonLabel })}
          </div>
        </div>
      </div>

      <div className="tw-border-t tw-border-edge tw-p-3">
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3">
          <div className="tw-text-[10px] tw-font-medium tw-text-[var(--vscode-foreground)]">{t("overview.tokenUsage")}</div>
          <div className="tw-text-[11px] tw-font-semibold tw-tabular-nums tw-text-[var(--vscode-foreground)]">
            {t("overview.total", { value: totalTokens })}
          </div>
        </div>

        <div className="tw-mt-1.5 tw-flex tw-flex-wrap tw-items-center tw-gap-1.5">
          <LegendChip label={t("overview.cached", { value: cacheHitPct.toFixed(1) })} color={chartColors.cacheRead} />
          <LegendChip label={t("common.input")} color={chartColors.input} />
          <LegendChip label={t("common.output")} color={chartColors.output} />
        </div>

        <div className="tw-mt-2.5 tw-grid tw-gap-1.5" style={THREE_COLUMN_GRID}>
          <TokenMetric label={t("overview.cachedTokens")} value={cachedTokens} tone="cache" />
          <TokenMetric label={t("overview.inputTokens")} value={inputTokens} tone="input" />
          <TokenMetric label={t("overview.outputTokens")} value={outputTokens} tone="output" />
        </div>
      </div>

      <div
        className="tw-grid tw-divide-x tw-divide-edge tw-border-t tw-border-edge tw-bg-recessed"
        style={FOUR_COLUMN_GRID}
      >
        <FooterMetric label={t("common.turns")} value={turns} />
        <FooterMetric label={t("overview.toolCalls")} value={toolCalls} />
        <FooterMetric label={t("common.models")} value={models} />
        <FooterMetric label={t("overview.costPerTurn")} value={costPerTurn} />
      </div>
    </section>
  );
}

function LegendChip({ label, color }: { label: string; color: string }) {
  return (
    <div className="tw-inline-flex tw-items-center tw-gap-1 tw-rounded-full tw-border tw-border-edge tw-bg-recessed tw-px-1.5 tw-py-0.5">
      <span className="tw-h-1.5 tw-w-1.5 tw-rounded-full" style={{ backgroundColor: color }} />
      <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">{label}</span>
    </div>
  );
}

function TokenMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "cache" | "input" | "output";
}) {
  // Same hue per token type as the trend chart, so the numbers and the bars agree.
  const toneClass = tone === "cache"
    ? "tw-text-chart-yellow"
    : tone === "input"
      ? "tw-text-chart-blue"
      : "tw-text-chart-green";

  return (
    <div className="tw-min-w-0 tw-rounded-md tw-border tw-border-edge tw-bg-recessed tw-px-2 tw-py-2">
      <div className="tw-truncate tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">{label}</div>
      <div className={`tw-mt-0.5 tw-truncate tw-text-[12px] tw-font-semibold tw-tabular-nums ${toneClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function FooterMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tw-min-w-0 tw-px-1.5 tw-py-2 tw-text-center">
      <div className="tw-truncate tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)]">{label}</div>
      <div className="tw-mt-0.5 tw-truncate tw-text-[10px] tw-font-semibold tw-tabular-nums tw-text-[var(--vscode-foreground)]" title={value}>
        {value}
      </div>
    </div>
  );
}
import { useTranslation } from "../i18n";
import { chartColors } from "../theme";
