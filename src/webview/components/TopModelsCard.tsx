import { Fragment, useEffect, useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { pRange, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { formatCostPerTurn } from "../format";
import { formatModelCost, modelCostTitle } from "../modelCost";
import { baseModelOf, effortOf } from "../../shared/variant";
import {
  formatEffortLabel,
  sortModelUsage,
  type ModelSortKey,
  type ModelUsageSummary,
  type SortDirection,
} from "../modelUsage";

const COLLAPSED_COUNT = 5;
const EXPANDED_COUNT = 10;
const DETAIL_GRID = { gridTemplateColumns: "repeat(5, minmax(0, 1fr))" };

export function TopModelsCard() {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>();
  const [sortKey, setSortKey] = useState<ModelSortKey>("tokens");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const result = useQuery("dashboard");
  const period = useStore((state) => state.granularity) as Period;
  const currency = useStore((state) => state.currency);

  useEffect(() => {
    if (!modalOpen) { return; }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setModalOpen(false); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modalOpen]);

  if (!result || result.view !== "dashboard") { return null; }

  const { from } = pRange(period);
  const summaries = new Map<string, Omit<ModelUsageSummary, "id" | "total" | "share">>();
  for (const row of result.series) {
    if (row.day < from) { continue; }
    const model = summaries.get(row.variantId) ?? {
      input: 0,
      output: 0,
      cache: 0,
      reasoning: 0,
      turns: 0,
      cost: 0,
      unknownCostTurns: 0,
      model: baseModelOf(row.variantId),
      source: row.source,
      effort: effortOf(row.variantId),
    };
    model.input += row.inputTokens;
    model.output += row.outputTokens;
    model.cache += row.cacheReadTokens + row.cacheCreationTokens;
    model.reasoning += row.reasoningTokens;
    model.turns += row.turns;
    model.cost += row.costUsd;
    model.unknownCostTurns += row.unknownCostTurns;
    summaries.set(row.variantId, model);
  }

  const totalTokens = [...summaries.values()].reduce(
    (sum, model) => sum + model.input + model.output + model.cache + model.reasoning,
    0,
  );
  const allModels = [...summaries.entries()]
    .map(([id, model]) => {
      const total = model.input + model.output + model.cache + model.reasoning;
      return { id, total, share: totalTokens > 0 ? (total / totalTokens) * 100 : 0, ...model };
    })
    .sort((left, right) => right.total - left.total);

  if (allModels.length === 0) { return null; }

  const visibleCount = expanded ? EXPANDED_COUNT : COLLAPSED_COUNT;
  const visibleModels = allModels.slice(0, visibleCount);
  const sortedModels = sortModelUsage(allModels, sortKey, sortDirection);

  const changeSort = (key: ModelSortKey) => {
    if (key === sortKey) {
      setSortDirection((direction) => direction === "desc" ? "asc" : "desc");
      return;
    }
    setSortKey(key);
    setSortDirection("desc");
  };

  return (
    <>
      <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e]">
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-px-3 tw-py-2.5">
          <span className="tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">Top models</span>
          <span className="tw-text-[9px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
            {allModels.length.toLocaleString()} models
          </span>
        </div>

        <ModelsTable
          models={visibleModels}
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          currency={currency}
        />

        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-[#2a2a3a] tw-bg-[#141426] tw-px-3 tw-py-2">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="tw-cursor-pointer tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
          >
            View all {allModels.length.toLocaleString()} models
          </button>
          {allModels.length > COLLAPSED_COUNT && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              className="tw-flex tw-cursor-pointer tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
            >
              {expanded ? "Show less" : "Show more"}
              <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
            </button>
          )}
        </div>
      </section>

      {modalOpen && (
        <div
          className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3"
          style={{ backgroundColor: "rgba(8, 8, 18, 0.86)" }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) { setModalOpen(false); }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="All models"
            className="tw-flex tw-max-h-full tw-w-full tw-max-w-[720px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-[#34344a] tw-bg-[#1a1a2e] tw-shadow-2xl"
          >
            <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-b tw-border-[#2a2a3a] tw-px-3 tw-py-2.5">
              <div>
                <div className="tw-text-[11px] tw-font-semibold">All models</div>
                <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
                  {allModels.length.toLocaleString()} models · click a row for details
                </div>
              </div>
              <button
                type="button"
                aria-label="Close all models"
                onClick={() => setModalOpen(false)}
                className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-[#25253a] hover:tw-text-[var(--vscode-foreground)]"
              >
                ×
              </button>
            </div>
            <div className="tw-overflow-auto">
              <ModelsTable
                models={sortedModels}
                selectedModel={selectedModel}
                onSelect={setSelectedModel}
                currency={currency}
                sortable
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={changeSort}
              />
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ModelsTable({
  models,
  selectedModel,
  onSelect,
  currency,
  sortable = false,
  sortKey,
  sortDirection,
  onSort,
}: {
  models: ModelUsageSummary[];
  selectedModel?: string;
  onSelect: (id: string | undefined) => void;
  currency: ReturnType<typeof useStore.getState>["currency"];
  sortable?: boolean;
  sortKey?: ModelSortKey;
  sortDirection?: SortDirection;
  onSort?: (key: ModelSortKey) => void;
}) {
  return (
    <table className="tw-w-full tw-table-fixed tw-border-collapse">
      <colgroup>
        <col style={{ width: "30%" }} />
        <col style={{ width: "13%" }} />
        <col style={{ width: "15%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "14%" }} />
      </colgroup>
      <thead>
        <tr className="tw-border-t tw-border-[#2a2a3a] tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
          <th className="tw-px-3 tw-py-1.5 tw-text-left tw-font-medium">Model</th>
          <th className="tw-px-1 tw-py-1.5 tw-text-left tw-font-medium">Effort</th>
          <SortableHeader label="Tokens" sort="tokens" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Turns" sort="turns" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Cost" sort="cost" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Token share" sort="share" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
        </tr>
      </thead>
      <tbody>
        {models.map((model) => {
          const selected = selectedModel === model.id;
          return (
            <Fragment key={model.id}>
              <tr
                role="button"
                tabIndex={0}
                aria-expanded={selected}
                onClick={() => onSelect(selected ? undefined : model.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(selected ? undefined : model.id);
                  }
                }}
                className={`tw-cursor-pointer tw-border-t tw-border-[#25253a] tw-text-[9px] hover:tw-bg-[#18182a] ${selected ? "tw-bg-[#18182a]" : ""}`}
              >
                <td className="tw-truncate tw-px-3 tw-py-1.5 tw-font-medium tw-text-[var(--vscode-foreground)]" title={model.model}>
                  {model.model}
                </td>
                <td
                  className="tw-truncate tw-px-1 tw-py-1.5 tw-text-left tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]"
                  title={model.effort ? `Effort: ${model.effort}` : model.source === "claude" ? "Effort is not reported in the Claude Code session log" : "Effort unavailable"}
                >
                  {model.effort ? formatEffortLabel(model.effort) : model.source === "claude" ? "-" : "N/A"}
                </td>
                <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
                  {fmtT(model.total)}
                </td>
                <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
                  {model.turns.toLocaleString()}
                </td>
                <td
                  className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-font-medium tw-tabular-nums tw-text-[#cca700]"
                  title={modelCostTitle(model.cost, model.unknownCostTurns, model.turns, currency)}
                >
                  {formatModelCost(model.cost, model.unknownCostTurns, model.turns)}
                </td>
                <td className="tw-truncate tw-px-3 tw-py-1.5 tw-text-right tw-font-medium tw-tabular-nums tw-text-[#50c8a8]">
                  {model.share.toFixed(1)}%
                </td>
              </tr>
              {selected && (
                <tr className="tw-border-t tw-border-[#25253a] tw-bg-[#141426]">
                  <td colSpan={6} className="tw-px-3 tw-py-2">
                    <div className="tw-grid tw-gap-1.5" style={DETAIL_GRID}>
                      <DetailMetric label="Input" value={fmtT(model.input)} />
                      <DetailMetric label="Output" value={fmtT(model.output)} />
                      <DetailMetric label="Cache" value={fmtT(model.cache)} />
                      <DetailMetric label="Reasoning" value={fmtT(model.reasoning)} />
                      <DetailMetric label="Cost / turn" value={formatCostPerTurn(model.turns > 0 ? model.cost / model.turns : 0)} />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function SortableHeader({
  label,
  sort,
  sortable,
  active,
  direction,
  onSort,
}: {
  label: string;
  sort: ModelSortKey;
  sortable: boolean;
  active?: ModelSortKey;
  direction?: SortDirection;
  onSort?: (key: ModelSortKey) => void;
}) {
  return (
    <th className="tw-px-1 tw-py-1.5 tw-text-right tw-font-medium">
      {sortable ? (
        <button
          type="button"
          onClick={() => onSort?.(sort)}
          className="tw-w-full tw-cursor-pointer tw-text-right hover:tw-text-[var(--vscode-foreground)]"
        >
          {label}{active === sort ? ` ${direction === "desc" ? "↓" : "↑"}` : ""}
        </button>
      ) : label}
    </th>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tw-min-w-0">
      <div className="tw-truncate tw-text-[7px] tw-text-[var(--vscode-descriptionForeground)]">{label}</div>
      <div className="tw-mt-0.5 tw-truncate tw-text-[9px] tw-font-medium tw-tabular-nums" title={value}>{value}</div>
    </div>
  );
}
