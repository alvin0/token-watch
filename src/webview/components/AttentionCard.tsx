import { useStore, vscodeApi } from "../store";
import { useQuery } from "../hooks/useQuery";
import { useTranslation } from "../i18n";
import { useCostFormat } from "../hooks/useCostFormat";
import { fmtT, pRange } from "../lib/periodData";
import type { Period } from "../lib/periodData";
import { detectCostAnomalies, highContextSessions } from "../../shared/analyticsFlags";
import type { WebviewRequest } from "../../shared/protocol";


/**
 * Things that make the numbers on screen wrong or absent, and nothing else.
 *
 * The bar is deliberately high: a warning here tells the reader to distrust a
 * total, so anything that cannot change a total does not belong. Skipped long
 * lines that held no token counts, and models with no price, both used to
 * appear and both made complete totals look incomplete; they live in
 * "Token Watch: Show Diagnostics" now. What is left is missing tokens, an
 * ingestion worker that stopped, and the two analytics thresholds.
 *
 * Renders nothing when there is nothing to say, which is the common case.
 */
export function AttentionCard() {
  const result = useQuery("dashboard");
  const warnings = useStore((s) => s.warnings);
  const workerHealth = useStore((s) => s.workerHealth);
  const analytics = useStore((s) => s.analytics);
  const period = useStore((s) => s.granularity) as Period;
  const dismissed = useStore((s) => s.dismissedWarnings);
  const dismissWarnings = useStore((s) => s.dismissWarnings);
  const { locale, t } = useTranslation();
  const money = useCostFormat();

  const items: Array<{ key: string; tone: "warn" | "info"; text: string; action?: { label: string; setting: string } }> = [];

  if (workerHealth?.status === "restarting") {
    items.push({ key: "worker-restarting", tone: "info", text: t("warnings.workerRestarting") });
  } else if (workerHealth?.status === "failed") {
    items.push({
      key: "worker-failed",
      tone: "warn",
      text: workerHealth.message ? `${t("warnings.workerFailed")} ${workerHealth.message}` : t("warnings.workerFailed"),
    });
  }

  // `warnings.unmappedModels` is deliberately NOT surfaced here. A model with
  // no price makes its cost read low; it does not make a token go missing, and
  // this card is now only about missing tokens. The list is in "Token Watch:
  // Show Diagnostics" under Pricing, next to the other rate problems.

  if (warnings.malformedLineCount > 0) {
    // Only lines that already matched a usage marker reach the parser, so a
    // parse failure here means countable data was dropped, not a cosmetic gap.
    items.push({
      key: `malformed:${warnings.malformedLineCount}`,
      tone: "warn",
      text: t("warnings.malformedLines", { count: warnings.malformedLineCount.toLocaleString(locale) }),
    });
  }

  if (warnings.lostUsageLineCount > 0) {
    // Missing numbers is the only thing worth interrupting the reader for.
    items.push({
      key: `lost-usage:${warnings.lostUsageLineCount}`,
      tone: "warn",
      text: t("warnings.lostUsageLines", { count: warnings.lostUsageLineCount.toLocaleString(locale) }),
      action: { label: t("warnings.openIngestionSetting"), setting: "ingestion.maxLineBytes" },
    });
  }

  // `warnings.oversizedLineCount` is deliberately NOT surfaced. Those are long
  // lines that provably carry no token counts — a big tool result, a file read
  // back — so nothing is missing because of them. Announcing them only made the
  // reader doubt totals that were already complete. The count stays in
  // "Token Watch: Show Diagnostics" for anyone who wants the number.

  if (result?.view === "dashboard") {
    const { from, to } = pRange(period);
    const anomalies = detectCostAnomalies(result.series, analytics.anomalyMultiplier)
      .filter((anomaly) => anomaly.day >= from && anomaly.day <= to);
    const worst = anomalies.reduce<typeof anomalies[number] | undefined>(
      (best, anomaly) => (!best || anomaly.ratio > best.ratio ? anomaly : best),
      undefined,
    );
    if (worst) {
      items.push({
        key: `anomaly:${worst.day}`,
        tone: "warn",
        text: `${t("insights.anomalyFlag")} · ${worst.day} — ${t("insights.anomalyDetail", {
          cost: money.cost(worst.costUsd),
          multiplier: analytics.anomalyMultiplier.toLocaleString(locale),
          days: 14,
          median: money.cost(worst.medianUsd),
        })}`,
      });
    }

    // Ordered by peak fill, so a high-context session is not missed just
    // because it did not make the cost top-20. Defaulted because an older host
    // predates the field, and the guard cannot vouch for a host it did not
    // ship with.
    const heavy = highContextSessions(result.contextSessions ?? [], analytics.contextFillWarnPct);
    if (heavy.length > 0) {
      items.push({
        key: `context:${heavy.length}:${Math.round(heavy[0].peakFillPct)}`,
        tone: "info",
        text: `${t("insights.contextFill")} · ${t("insights.contextFillDetail", {
          count: heavy.length.toLocaleString(locale),
          threshold: analytics.contextFillWarnPct.toLocaleString(locale),
        })} — ${heavy[0].peakFillPct.toFixed(0)}% · ${fmtT(heavy[0].totalTokens)}`,
      });
    }
  }

  // Each item's key encodes its content, so a dismissed warning reappears only
  // if the underlying numbers change.
  const visible = items.filter((item) => !dismissed.includes(item.key));
  if (visible.length === 0) { return null; }

  return (
    <section
      className="tw-rounded-lg tw-border tw-border-edge tw-bg-card tw-p-3"
      aria-label={t("warnings.title")}
    >
      <div className="tw-mb-1.5 tw-flex tw-items-center tw-justify-between tw-gap-3">
        <span className="tw-text-[10px] tw-font-medium tw-uppercase tw-tracking-wide">{t("warnings.title")}</span>
        <button
          type="button"
          aria-label={t("warnings.dismiss")}
          onClick={() => {
            for (const item of visible) { dismissWarnings(item.key); }
          }}
          className="tw-cursor-pointer tw-rounded tw-px-1.5 tw-py-0.5 tw-text-[11px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-bg-hover hover:tw-text-[var(--vscode-foreground)]"
        >
          ×
        </button>
      </div>
      <ul className="tw-m-0 tw-list-none tw-space-y-1.5 tw-p-0">
        {visible.map((item) => (
          <li key={item.key} className="tw-flex tw-items-start tw-gap-1.5 tw-text-[9px] tw-leading-snug">
            <span
              aria-hidden="true"
              className={`tw-mt-[3px] tw-h-1.5 tw-w-1.5 tw-shrink-0 tw-rounded-full ${
                item.tone === "warn" ? "tw-bg-chart-orange" : "tw-bg-chart-blue"
              }`}
            />
            <span className="tw-min-w-0 tw-flex-1 tw-text-[var(--vscode-descriptionForeground)]">
              {item.text}
              {item.action && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => openSetting(item.action!.setting)}
                    className="tw-cursor-pointer tw-text-[var(--vscode-textLink-foreground)] hover:tw-underline"
                  >
                    {item.action.label}
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function openSetting(key: string): void {
  vscodeApi.postMessage({ type: "openSetting", key } satisfies WebviewRequest);
}
