export function LoadingState({ processed, total, label }: { processed: number; total: number; label?: string }) {
  const pct = total > 0 ? (processed / total) * 100 : 0;
  return (
    <div className="tw-flex tw-flex-col tw-items-center tw-justify-center tw-h-full tw-gap-3 tw-p-6">
      <div className="tw-w-full tw-max-w-[160px] tw-h-1 tw-rounded-full tw-bg-[#1a1a2e] tw-overflow-hidden">
        <div className="tw-h-full tw-bg-[var(--vscode-focusBorder)] tw-transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="tw-text-[10px] tw-text-[var(--vscode-descriptionForeground)]">{label ?? `Scanning ${processed} of ${total} files`}</p>
    </div>
  );
}
