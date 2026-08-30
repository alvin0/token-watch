/**
 * Chart theming from the active VS Code theme.
 *
 * Two shapes are needed because SVG presentation attributes (Recharts `fill`,
 * `stroke`) do not resolve CSS variables: `chartColors` for real CSS
 * declarations, and `resolveChartPalette` for the concrete values SVG needs.
 * The hex values are the fallback for themes that omit a chart color.
 */

const CHART_COLOR_SOURCES = {
  input: { variable: "--vscode-charts-blue", fallback: "#4fc1ff" },
  output: { variable: "--vscode-charts-green", fallback: "#89d185" },
  cacheRead: { variable: "--vscode-charts-yellow", fallback: "#cca700" },
  cacheCreation: { variable: "--vscode-charts-orange", fallback: "#e07c3e" },
  reasoning: { variable: "--vscode-charts-purple", fallback: "#b180d7" },
  cost: { variable: "--vscode-charts-red", fallback: "#f14c4c" },
  // panel.border is a translucent grey with a defined value in every theme,
  // unlike widget.border, which themes may leave unset.
  grid: { variable: "--vscode-panel-border", fallback: "#80808059" },
  muted: { variable: "--vscode-descriptionForeground", fallback: "#888888" },
  surface: { variable: "--vscode-editorWidget-background", fallback: "#1a1a2e" },
} as const;

export type ChartPalette = Record<keyof typeof CHART_COLOR_SOURCES, string>;

/** CSS-variable references, for style declarations and Tailwind arbitrary values. */
export const chartColors = Object.fromEntries(
  Object.entries(CHART_COLOR_SOURCES).map(([key, { variable, fallback }]) => [key, `var(${variable}, ${fallback})`]),
) as ChartPalette;

/** Concrete colors read off the active theme, for SVG attributes. */
export function resolveChartPalette(): ChartPalette {
  const styles = typeof window === "undefined" ? undefined : window.getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(CHART_COLOR_SOURCES).map(([key, { variable, fallback }]) => [
      key,
      styles?.getPropertyValue(variable).trim() || fallback,
    ]),
  ) as ChartPalette;
}

export const chartLayout = {
  margin: { top: 8, right: 8, bottom: 24, left: 40 },
};
