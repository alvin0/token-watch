import { Fragment, useCallback, useState } from "react";
import { useStore } from "../store";
import { useQuery } from "../hooks/useQuery";
import { pRange, fmtT } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { useCostFormat } from "../hooks/useCostFormat";
import { formatModelCost, modelCostTitle } from "../modelCost";
import { effortOf } from "../../shared/variant";
import { summarizeModels } from "../../shared/modelSummary";
import {
  formatEffortLabel,
  sortModelUsage,
  type ModelSortKey,
  type ModelUsageSummary,
  type SortDirection,
} from "../modelUsage";
import { useTranslation } from "../i18n";
import { useModalFocus } from "../hooks/useModalFocus";
import { Chevron } from "./Chevron";

const COLLAPSED_COUNT = 3;
const EXPANDED_COUNT = 10;
const DETAIL_GRID = { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" };

export function TopModelsCard() {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>();
  const [sortKey, setSortKey] = useState<ModelSortKey>("tokens");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const result = useQuery("dashboard");
  const period = useStore((state) => state.granularity) as Period;
  const currency = useStore((state) => state.currency);
  const { locale, t } = useTranslation();

  const closeModal = useCallback(() => setModalOpen(false), []);
  // Traps Tab inside the dialog and restores focus to the opener on close.
  const dialogRef = useModalFocus<HTMLElement>({ open: modalOpen, onClose: closeModal });

  if (!result || result.view !== "dashboard") { return null; }

  const { from, to } = pRange(period);
  // summarizeModels keys on source + variant, so Codex and Claude models that
  // share an id never merge, and one model used from several workspaces stays
  // a single row.
  const allModels: ModelUsageSummary[] = summarizeModels(
    result.series.filter((row) => row.day >= from && row.day <= to),
  ).map((model) => ({ ...model, effort: effortOf(model.variantId) }));

  if (allModels.length === 0) { return null; }

  const visibleCount = expanded ? EXPANDED_COUNT : COLLAPSED_COUNT;
  const visibleModels = allModels.slice(0, visibleCount);
  const sortedModels = sortModelUsage(allModels, sortKey, sortDirection);
  const hiddenModels = allModels.length - visibleModels.length;
  const canToggle = allModels.length > COLLAPSED_COUNT;
  const showFooter = hiddenModels > 0 || canToggle;

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
      <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-edge tw-bg-card">
        <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-px-3 tw-py-2.5">
          <span className="tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">{t("models.top")}</span>
          <span className="tw-text-[9px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
            {t("models.count", { count: allModels.length.toLocaleString(locale) })}
          </span>
        </div>

        <ModelsTable
          models={visibleModels}
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          currency={currency}
        />

        {showFooter && (
          <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-edge tw-bg-recessed tw-px-3 tw-py-2">
            {hiddenModels > 0 ? (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="tw-cursor-pointer tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
              >
                {t("models.viewAll", { count: allModels.length.toLocaleString(locale) })}
              </button>
            ) : <span />}
            {canToggle && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="tw-flex tw-cursor-pointer tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
              >
                {expanded ? t("common.showLess") : t("common.showMore")}
                <Chevron up={expanded} />
              </button>
            )}
          </div>
        )}
      </section>

      {modalOpen && (
        <div
          className="tw-fixed tw-inset-0 tw-z-50 tw-flex tw-items-center tw-justify-center tw-p-3 tw-bg-scrim"
         
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) { setModalOpen(false); }
          }}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("models.all")}
            tabIndex={-1}
            className="tw-flex tw-max-h-full tw-w-full tw-max-w-[720px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-control tw-bg-card tw-shadow-widget tw-outline-none"
          >
            <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-b tw-border-edge tw-px-3 tw-py-2.5">
              <div>
                <div className="tw-text-[11px] tw-font-semibold">{t("models.all")}</div>
                <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
                  {t("models.detailsHint", { count: allModels.length.toLocaleString(locale) })}
                </div>
              </div>
              <button
                type="button"
                aria-label={t("models.close")}
                onClick={() => setModalOpen(false)}
                className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
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
  const { language, locale, t } = useTranslation();
  const money = useCostFormat();
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
        <tr className="tw-border-t tw-border-edge tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
          <th className="tw-px-3 tw-py-1.5 tw-text-left tw-font-medium">{t("common.model")}</th>
          <th className="tw-px-1 tw-py-1.5 tw-text-left tw-font-medium">{t("common.effort")}</th>
          <SortableHeader label={t("common.tokens")} sort="tokens" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label={t("common.turns")} sort="turns" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label={t("common.cost")} sort="cost" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label={t("models.tokenShare")} sort="share" sortable={sortable} active={sortKey} direction={sortDirection} onSort={onSort} />
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
                className={`tw-cursor-pointer tw-border-t tw-border-edge tw-text-[9px] hover:tw-bg-hover ${selected ? "tw-bg-hover" : ""}`}
              >
                <td className="tw-truncate tw-px-3 tw-py-1.5 tw-font-medium tw-text-[var(--vscode-foreground)]" title={`${model.baseModel} · ${model.source}`}>
                  {model.baseModel}
                </td>
                <td
                  className="tw-truncate tw-px-1 tw-py-1.5 tw-text-left tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]"
                  title={model.effort ? t("models.effortValue", { effort: model.effort }) : model.source === "claude" ? t("models.effortClaudeMissing") : t("models.effortUnavailable")}
                >
                  {model.effort ? formatEffortLabel(model.effort) : model.source === "claude" ? "-" : "N/A"}
                </td>
                <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
                  {fmtT(model.total)}
                </td>
                <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
                  {model.turns.toLocaleString(locale)}
                </td>
                <td
                  className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-font-medium tw-tabular-nums tw-text-chart-yellow"
                  title={modelCostTitle(model.cost, model.unknownCostTurns, model.turns, currency, language)}
                >
                  {formatModelCost(model.cost, model.unknownCostTurns, model.turns, currency, locale)}
                </td>
                <td className="tw-truncate tw-px-3 tw-py-1.5 tw-text-right tw-font-medium tw-tabular-nums tw-text-chart-green">
                  {model.share.toFixed(1)}%
                </td>
              </tr>
              {selected && (
                <tr className="tw-border-t tw-border-edge tw-bg-recessed">
                  <td colSpan={6} className="tw-px-3 tw-py-2">
                    <div className="tw-grid tw-gap-1.5" style={DETAIL_GRID}>
                      <DetailMetric label={t("common.input")} value={fmtT(model.input)} />
                      <DetailMetric label={t("common.output")} value={fmtT(model.output)} />
                      <DetailMetric label={t("common.cacheRead")} value={fmtT(model.cacheRead)} />
                      <DetailMetric label={t("common.cacheWrite")} value={fmtT(model.cacheWrite)} />
                      <DetailMetric label={t("common.reasoning")} value={fmtT(model.reasoning)} />
                      <DetailMetric label={t("overview.costPerTurn")} value={money.perTurn(model.turns > 0 ? model.cost / model.turns : 0)} />
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
