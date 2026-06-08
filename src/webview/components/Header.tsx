import { vscodeApi } from "../store";

export function Header({ status }: { status: string }) {
  const c = status === "Live" ? "#89d185" : status === "Scanning" || status === "Stale" ? "#cca700" : "#888";
  return (
    <div className="tw-shrink-0 tw-px-3 tw-pt-2 tw-pb-1 tw-flex tw-items-center tw-gap-2">
      <span className="tw-text-[13px] tw-font-bold tw-text-[var(--vscode-foreground)]">Token Watch</span>
      <span className="tw-flex tw-items-center tw-gap-1 tw-text-[9px]" style={{ color: c }}>
        <span className="tw-w-[5px] tw-h-[5px] tw-rounded-full" style={{ backgroundColor: c }} />{status}
      </span>
      <div className="tw-ml-auto tw-flex tw-items-center tw-gap-1">
        <button
          title="Reset database"
          aria-label="Reset database"
          onClick={() => vscodeApi.postMessage({ type: "resetDatabase" })}
          className="tw-rounded tw-border tw-border-[var(--vscode-inputValidation-errorBorder)] tw-px-1.5 tw-py-0.5 tw-text-[9px] tw-text-[var(--vscode-errorForeground)] hover:tw-bg-[var(--vscode-inputValidation-errorBackground)] tw-cursor-pointer"
        >
          Reset
        </button>
        <button
          title="Rescan logs"
          aria-label="Rescan logs"
          onClick={() => vscodeApi.postMessage({ type: "rescan" })}
          className="tw-text-[12px] tw-text-[var(--vscode-descriptionForeground)] hover:tw-text-[var(--vscode-foreground)] tw-cursor-pointer"
        >
          &#8635;
        </button>
      </div>
    </div>
  );
}
