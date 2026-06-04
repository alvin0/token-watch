import { vscodeApi } from "../store";

export function Header({ status }: { status: string }) {
  const c = status === "Live" ? "#89d185" : status === "Scanning" || status === "Stale" ? "#cca700" : "#888";
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pt-2 tw-pb-1 tw-flex tw-items-center tw-gap-2">
      <span className="tw-text-[13px] tw-font-bold tw-text-[var(--vscode-foreground)]">Token Watch</span>
      <span className="tw-flex tw-items-center tw-gap-1 tw-text-[9px]" style={{ color: c }}>
        <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full" style={{ backgroundColor: c }} />{status}
      </span>
      <button
        title="Rescan logs"
        aria-label="Rescan logs"
        onClick={() => vscodeApi.postMessage({ type: "rescan" })}
        className="tw-ml-auto tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-text-[var(--vscode-foreground)] tw-cursor-pointer">↻</button>
    </div>
  );
}
