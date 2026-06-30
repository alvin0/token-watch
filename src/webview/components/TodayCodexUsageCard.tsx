import { useStore } from "../store";
import { formatPercent } from "../../shared/codexUsage";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function TodayCodexUsageCard() {
  const rateLimit = useStore((s) => s.rateLimit);
  if (!rateLimit) {
    return null;
  }

  const primaryResetAtUtc = typeof rateLimit.remainingSeconds === "number"
    ? Date.now() + rateLimit.remainingSeconds * 1_000
    : undefined;

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-mb-2">
        <span className="tw-text-[10px] tw-font-medium">Codex Usage</span>
      </div>

      <div className="tw-space-y-1.5">
        <UsageLine
          accent="blue"
          label="5h limit"
          value={remainingPercent(rateLimit.primaryPct)}
          detail={formatTime(primaryResetAtUtc)}
        />
        <UsageLine
          accent="purple"
          label="Weekly"
          value={remainingPercent(rateLimit.secondaryPct)}
          detail={formatDate(rateLimit.weeklyResetAtUtc)}
        />
      </div>
    </div>
  );
}

function UsageLine({
  accent,
  label,
  value,
  detail,
}: {
  accent: "blue" | "purple";
  label: string;
  value: string;
  detail: string;
}) {
  const accentClasses = accent === "blue"
    ? { icon: "tw-bg-[#0f1728] tw-ring-[#24324d]", value: "tw-text-[#79adff]" }
    : { icon: "tw-bg-[#1a1326] tw-ring-[#35254d]", value: "tw-text-[#c49aff]" };

  return (
    <div className="tw-flex tw-items-center tw-justify-between tw-gap-3 tw-rounded-md tw-border tw-border-[#25253a] tw-bg-[#141426] tw-px-2.5 tw-py-1.5">
      <div className="tw-flex tw-min-w-0 tw-items-center tw-gap-2">
        <div className="tw-min-w-0">
          <div className="tw-truncate tw-text-[9px] tw-font-medium tw-text-[var(--vscode-descriptionForeground)]">
            {label}
          </div>
        </div>
      </div>

      <div className="tw-flex tw-shrink-0 tw-items-baseline tw-gap-2 tw-tabular-nums">
        <div className={`tw-text-[13px] tw-font-bold tw-leading-none ${accentClasses.value}`}>
          {value}
        </div>
        <div className="tw-text-[10px] tw-leading-none tw-text-[var(--vscode-descriptionForeground)]">
          {detail}
        </div>
      </div>
    </div>
  );
}

function remainingPercent(usedPercent?: number): string {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return "—";
  }
  const remaining = Math.max(0, 100 - usedPercent);
  return formatPercent(remaining);
}

function formatTime(utcMs?: number): string {
  if (typeof utcMs !== "number" || !Number.isFinite(utcMs)) {
    return "—";
  }
  return timeFormatter.format(new Date(utcMs));
}

function formatDate(utcMs?: number): string {
  if (typeof utcMs !== "number" || !Number.isFinite(utcMs)) {
    return "—";
  }
  return dateFormatter.format(new Date(utcMs));
}