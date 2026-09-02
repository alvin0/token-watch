/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/webview/**/*.{ts,tsx}"],
  // Prefix all classes to avoid collisions with VS Code's own styles
  prefix: "tw-",
  corePlugins: {
    // Preflight resets conflict with VS Code's base styles
    preflight: false,
  },
  theme: {
    extend: {
      // Semantic names over VS Code theme colors. Surfaces resolve through the
      // --tk-* tokens in index.css; chart hues map straight to VS Code's own
      // chart palette, which is hue-named for the same reason.
      colors: {
        card: "var(--tk-card)",
        edge: "var(--tk-edge)",
        recessed: "var(--tk-recessed)",
        track: "var(--tk-track)",
        hover: "var(--tk-hover)",
        control: "var(--tk-control)",
        "danger-bg": "var(--tk-danger-bg)",
        scrim: "var(--tk-scrim)",
        // Fallbacks are required: a bare var() for a color the theme does not
        // define is invalid at computed-value time, which drops the text back to
        // the inherited foreground instead of showing the intended color.
        "chart-blue": "var(--vscode-charts-blue, #4fc1ff)",
        "chart-green": "var(--vscode-charts-green, #89d185)",
        "chart-yellow": "var(--vscode-charts-yellow, #cca700)",
        "chart-orange": "var(--vscode-charts-orange, #e07c3e)",
        "chart-red": "var(--vscode-charts-red, #f14c4c)",
        "chart-purple": "var(--vscode-charts-purple, #b180d7)",
      },
      boxShadow: {
        widget: "0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36))",
      },
    },
  },
  plugins: [],
};
