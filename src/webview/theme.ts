/**
 * Chart theming utilities using VS Code CSS variables and Tailwind layout classes.
 * Used by all Recharts-based charts in the dashboard.
 */

export const chartColors = {
  input: "var(--vscode-charts-blue)",
  output: "var(--vscode-charts-green)",
  cacheRead: "var(--vscode-charts-yellow)",
  cacheCreation: "var(--vscode-charts-orange)",
  reasoning: "var(--vscode-charts-purple)",
  cost: "var(--vscode-charts-red)",
  // Fallback colors for environments without chart variables
  inputFallback: "#4fc1ff",
  outputFallback: "#89d185",
  cacheReadFallback: "#cca700",
  cacheCreationFallback: "#e07c3e",
  reasoningFallback: "#b180d7",
  costFallback: "#f14c4c",
};

export const chartLayout = {
  margin: { top: 8, right: 8, bottom: 24, left: 40 },
};
