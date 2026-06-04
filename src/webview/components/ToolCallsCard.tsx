import { useQuery } from "../hooks/useQuery";

export function ToolCallsCard() {
  const result = useQuery("dashboard");
  if (!result || result.view !== "dashboard") { return null; }

  const tools = result.tools;
  const totalCalls = tools.reduce((sum, row) => sum + row.count, 0);
  if (totalCalls === 0) { return null; }

  const uniqueTools = new Set(tools.map((row) => row.toolName)).size;
  const topTools = tools.slice(0, 6);
  const topTool = topTools[0];

  return (
    <div className="tw-rounded-lg tw-border tw-border-[#2a2a3a] tw-bg-[#1a1a2e] tw-p-3">
      <div className="tw-flex tw-items-start tw-justify-between tw-gap-3 tw-mb-2">
        <div>
          <div className="tw-text-[10px] tw-font-medium">Tool calls</div>
          <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
            {uniqueTools.toLocaleString()} tool{uniqueTools !== 1 ? "s" : ""} used
          </div>
        </div>
        <div className="tw-text-right tw-shrink-0">
          <div className="tw-text-[18px] tw-font-bold tw-tabular-nums">{totalCalls.toLocaleString()}</div>
          <div className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)]">
            {topTool ? `${topTool.toolName} leads` : "no leader"}
          </div>
        </div>
      </div>
      <div className="tw-space-y-1.5">
        {topTools.map((tool) => {
          const pct = totalCalls > 0 ? (tool.count / totalCalls) * 100 : 0;
          return (
            <div key={`${tool.source}:${tool.toolName}`} className="tw-flex tw-items-center tw-gap-2">
              <span
                className="tw-text-[9px] tw-w-[96px] tw-truncate tw-shrink-0 tw-text-[var(--vscode-foreground)]"
                title={tool.toolName}
              >
                {tool.toolName}
              </span>
              <span className="tw-text-[8px] tw-w-[42px] tw-text-[var(--vscode-descriptionForeground)] tw-shrink-0">
                {tool.source}
              </span>
              <div className="tw-flex-1 tw-h-[6px] tw-rounded-sm tw-overflow-hidden tw-bg-[#11111f]">
                <div
                  className="tw-h-full tw-bg-[#4fc1ff]"
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>
              <span className="tw-text-[8px] tw-text-[var(--vscode-descriptionForeground)] tw-tabular-nums tw-w-[34px] tw-text-right">
                {tool.count.toLocaleString()}
              </span>
              <span className="tw-text-[9px] tw-font-medium tw-text-[#50c8a8] tw-tabular-nums tw-w-[34px] tw-text-right">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
