interface UsageOverviewMetric {
  label: string;
  value: string;
  tone?: "blue" | "yellow" | "cyan";
}

interface UsageOverviewCardProps {
  title: string;
  cost: string;
  delta: number;
  deltaLabel: string;
  metrics?: UsageOverviewMetric[];
  metricGroups?: UsageOverviewMetric[][];
  sharePct: number;
}

export function UsageOverviewCard({ title, cost, delta, deltaLabel, metrics, metricGroups, sharePct }: UsageOverviewCardProps) {
  const clampedShare = clampPct(sharePct);
  const deltaColor = delta === 0 ? "tw-text-[#f0d36a]" : delta < 0 ? "tw-text-[#f87171]" : "tw-text-[#89d185]";
  const deltaPrefix = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const groups = metricGroups ?? chunkMetrics(metrics ?? [], 2);

  return (
    <div className="tw-rounded-md tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-start tw-justify-between tw-gap-3">
        <div className="tw-min-w-0">
          <div className="tw-truncate tw-text-[10px] tw-font-medium tw-text-[var(--vscode-descriptionForeground)]">
            {title}
          </div>
          <div className="tw-mt-1 tw-text-[28px] tw-font-bold tw-leading-none tw-tabular-nums tw-text-[var(--vscode-foreground)]">
            {cost}
          </div>
        </div>
        <div className="tw-shrink-0 tw-text-right">
          <div className={`tw-text-[13px] tw-font-semibold tw-tabular-nums ${deltaColor}`}>
            {deltaPrefix}{Math.abs(delta).toFixed(1)}%
          </div>
          <div className={`tw-text-[8px] ${deltaColor}`}>{deltaLabel}</div>
        </div>
      </div>

      <div className="tw-mt-3 tw-space-y-1.5">
        {groups.map((group, index) => (
          <div key={index} className="tw-grid tw-gap-1.5" style={gridStyle(group.length)}>
            {group.map((metric) => (
              <MetricRow key={metric.label} metric={metric} />
            ))}
          </div>
        ))}
      </div>

      <div className="tw-mt-3 tw-border-t tw-border-[#2a2a3a] tw-pt-2">
        <div className="tw-flex tw-justify-end">
          <div className="tw-text-[12px] tw-font-semibold tw-tabular-nums tw-text-[var(--vscode-foreground)]">
            {clampedShare.toFixed(1)}%
          </div>
        </div>
        <div className="tw-mt-1.5 tw-h-1.5 tw-overflow-hidden tw-rounded-full tw-bg-[#0d0d1a]">
          <div
            className="tw-h-full tw-rounded-full tw-bg-[#50c8a8]"
            style={{ width: `${clampedShare}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function MetricRow({ metric }: { metric: UsageOverviewMetric }) {
  const tone = metricToneClass(metric.tone);

  return (
    <div className="tw-flex tw-min-w-0 tw-items-center tw-justify-between tw-gap-2 tw-rounded-md tw-border tw-border-[#25253a] tw-bg-[#141426] tw-px-2 tw-py-1.5">
      <div className={`tw-min-w-0 tw-truncate tw-text-[9px] ${tone.label}`}>
        {metric.label}
      </div>
      <div className={`tw-shrink-0 tw-text-[12px] tw-font-semibold tw-tabular-nums ${tone.value}`}>
        {metric.value}
      </div>
    </div>
  );
}

function gridStyle(count: number): { gridTemplateColumns: string } {
  return { gridTemplateColumns: `repeat(${Math.max(1, count)}, minmax(0, 1fr))` };
}

function chunkMetrics(metrics: UsageOverviewMetric[], size: number): UsageOverviewMetric[][] {
  const chunks: UsageOverviewMetric[][] = [];
  for (let index = 0; index < metrics.length; index += size) {
    chunks.push(metrics.slice(index, index + size));
  }
  return chunks;
}

function metricToneClass(tone: UsageOverviewMetric["tone"]): { label: string; value: string } {
  if (tone === "blue") { return { label: "tw-text-[#6aa7ff]", value: "tw-text-[#6aa7ff]" }; }
  if (tone === "yellow") { return { label: "tw-text-[#f0d36a]", value: "tw-text-[#f0d36a]" }; }
  if (tone === "cyan") { return { label: "tw-text-[#4fc1ff]", value: "tw-text-[#4fc1ff]" }; }
  return { label: "tw-text-[var(--vscode-descriptionForeground)]", value: "tw-text-[var(--vscode-foreground)]" };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) { return 0; }
  return Math.max(0, Math.min(100, value));
}
