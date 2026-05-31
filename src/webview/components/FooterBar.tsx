import { useStore, vscodeApi } from "../store";

export function FooterBar() {
  const freshness = useStore((s) => s.freshness);
  const lastUpdated = freshness.latestRecordUtc ? new Date(freshness.latestRecordUtc).toLocaleTimeString() : "—";
  return (
    <div className="tw-shrink-0 tw-border-t tw-border-[#2a2a3a] tw-px-3 tw-py-1.5 tw-flex tw-items-center tw-justify-between tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
      <button onClick={() => vscodeApi.postMessage({ type: "rescan" })} className="tw-cursor-pointer hover:tw-text-[var(--vscode-foreground)]">↻ Refresh data</button>
      <span className="tw-flex tw-items-center tw-gap-1">Last updated: {lastUpdated} <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full tw-bg-[#89d185]" /></span>
    </div>
  );
}
