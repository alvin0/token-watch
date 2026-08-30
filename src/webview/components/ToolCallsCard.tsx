import { useEffect, useState } from "react";
import type { ToolUsageRow } from "../../shared/storeTypes";
import { useQuery } from "../hooks/useQuery";
import {
  filterToolUsage,
  summarizeToolUsage,
  toolSourceLabel,
  type ToolSourceFilter,
} from "../toolUsage";
import { useTranslation } from "../i18n";

const EXPANDED_TOOL_LIMIT = 6;

export function ToolCallsCard() {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<ToolSourceFilter>("all");
  const result = useQuery("dashboard");
  const { locale, t } = useTranslation();

  useEffect(() => {
    if (!modalOpen) { return; }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setModalOpen(false); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modalOpen]);

  if (!result || result.view !== "dashboard") { return null; }

  const tools = result.tools;
  const summary = summarizeToolUsage(tools);
  const sourceSummary = [
    summary.codexCalls > 0 ? `Codex ${summary.codexCalls.toLocaleString(locale)} ${t("common.calls").toLocaleLowerCase(locale)}` : "",
    summary.claudeCalls > 0 ? `Claude Code ${summary.claudeCalls.toLocaleString(locale)} ${t("common.calls").toLocaleLowerCase(locale)}` : "",
  ].filter(Boolean).join(" · ");
  const visibleTools = tools.slice(0, EXPANDED_TOOL_LIMIT);
  const filteredTools = filterToolUsage(tools, sourceFilter);

  return (
    <>
      <section className="tw-overflow-hidden tw-rounded-lg tw-border tw-border-edge tw-bg-card">
        <div className="tw-px-3 tw-py-2.5">
          <div className="tw-flex tw-items-center tw-justify-between tw-gap-3">
            <span className="tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">{t("tools.title")}</span>
            {summary.totalCalls > 0 && (
              <span className="tw-shrink-0 tw-text-[9px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
                {t("tools.totalCalls", { count: summary.totalCalls.toLocaleString(locale) })}
              </span>
            )}
          </div>

          {summary.totalCalls > 0 ? (
            <div className="tw-mt-1.5 tw-flex tw-items-center tw-justify-between tw-gap-3">
              <span className="tw-min-w-0 tw-truncate tw-text-[9px] tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]" title={sourceSummary}>
                {sourceSummary}
              </span>
              {!expanded && (
                <button
                  type="button"
                  aria-expanded={false}
                  onClick={() => setExpanded(true)}
                  className="tw-flex tw-shrink-0 tw-cursor-pointer tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
                >
                  {t("common.showMore")} <span aria-hidden="true">⌄</span>
                </button>
              )}
            </div>
          ) : (
            <div className="tw-mt-1.5 tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
              {t("tools.noCalls")}
            </div>
          )}
        </div>

        {expanded && summary.totalCalls > 0 && (
          <>
            <ToolsTable tools={visibleTools} />
            <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-border-t tw-border-edge tw-bg-recessed tw-px-3 tw-py-2">
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="tw-cursor-pointer tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
              >
                {t("tools.viewAll", { count: summary.uniqueTools.toLocaleString(locale) })}
              </button>
              <button
                type="button"
                aria-expanded={true}
                onClick={() => setExpanded(false)}
                className="tw-flex tw-cursor-pointer tw-items-center tw-gap-1.5 tw-text-[9px] tw-font-medium tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
              >
                {t("common.showLess")} <span aria-hidden="true">⌃</span>
              </button>
            </div>
          </>
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
            role="dialog"
            aria-modal="true"
            aria-label={t("tools.all")}
            className="tw-flex tw-max-h-full tw-w-full tw-max-w-[720px] tw-flex-col tw-overflow-hidden tw-rounded-lg tw-border tw-border-control tw-bg-card tw-shadow-widget"
          >
            <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-border-b tw-border-edge tw-px-3 tw-py-2.5">
              <div>
                <div className="tw-text-[11px] tw-font-semibold">{t("tools.all")}</div>
                <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
                  {t("tools.summary", { calls: summary.totalCalls.toLocaleString(locale), tools: summary.uniqueTools.toLocaleString(locale) })}
                </div>
              </div>
              <button
                type="button"
                aria-label={t("tools.close")}
                onClick={() => setModalOpen(false)}
                className="tw-cursor-pointer tw-rounded tw-px-2 tw-py-1 tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
              >
                ×
              </button>
            </div>

            <div className="tw-flex tw-gap-1.5 tw-border-b tw-border-edge tw-px-3 tw-py-2">
              <SourceFilter label={t("common.all")} value="all" current={sourceFilter} onChange={setSourceFilter} />
              <SourceFilter label="Codex" value="codex" current={sourceFilter} onChange={setSourceFilter} />
              <SourceFilter label="Claude Code" value="claude" current={sourceFilter} onChange={setSourceFilter} />
            </div>

            <div className="tw-overflow-auto">
              {filteredTools.length > 0 ? (
                <ToolsTable tools={filteredTools} />
              ) : (
                <div className="tw-p-4 tw-text-center tw-text-[9px] tw-text-[var(--vscode-descriptionForeground)]">
                  {t("tools.noSource")}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ToolsTable({ tools }: { tools: ToolUsageRow[] }) {
  const { locale, t } = useTranslation();
  return (
    <table className="tw-w-full tw-table-fixed tw-border-collapse">
      <colgroup>
        <col style={{ width: "42%" }} />
        <col style={{ width: "24%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "16%" }} />
      </colgroup>
      <thead>
        <tr className="tw-border-t tw-border-edge tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
          <th className="tw-px-3 tw-py-1.5 tw-text-left tw-font-medium">{t("common.tool")}</th>
          <th className="tw-px-1 tw-py-1.5 tw-text-left tw-font-medium">{t("common.source")}</th>
          <th className="tw-px-1 tw-py-1.5 tw-text-right tw-font-medium">{t("common.calls")}</th>
          <th className="tw-px-3 tw-py-1.5 tw-text-right tw-font-medium">{t("common.share")}</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool, index) => (
          <tr
            key={`${tool.source}:${tool.toolName}:${tool.isSidechain ? "sidechain" : "main"}:${index}`}
            className="tw-border-t tw-border-edge tw-text-[9px] hover:tw-bg-hover"
          >
            <td className="tw-truncate tw-px-3 tw-py-1.5 tw-font-medium" title={tool.toolName}>
              {tool.toolName}
            </td>
            <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-[8px] tw-uppercase tw-tracking-wide tw-text-[var(--vscode-descriptionForeground)]">
              {toolSourceLabel(tool.source)}
            </td>
            <td className="tw-truncate tw-px-1 tw-py-1.5 tw-text-right tw-tabular-nums tw-text-[var(--vscode-descriptionForeground)]">
              {tool.count.toLocaleString(locale)}
            </td>
            <td className="tw-truncate tw-px-3 tw-py-1.5 tw-text-right tw-font-medium tw-tabular-nums tw-text-chart-green">
              {tool.sharePct.toFixed(1)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceFilter({
  label,
  value,
  current,
  onChange,
}: {
  label: string;
  value: ToolSourceFilter;
  current: ToolSourceFilter;
  onChange: (value: ToolSourceFilter) => void;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(value)}
      className={`tw-cursor-pointer tw-rounded tw-border tw-px-2 tw-py-1 tw-text-[8px] tw-font-medium ${
        active
          ? "tw-border-[var(--vscode-focusBorder)] tw-bg-hover tw-text-[var(--vscode-foreground)]"
          : "tw-border-edge tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover"
      }`}
    >
      {label}
    </button>
  );
}
