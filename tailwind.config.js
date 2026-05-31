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
    extend: {},
  },
  plugins: [],
};
