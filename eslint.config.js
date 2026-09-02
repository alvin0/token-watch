// ESLint 9 flat config. Replaces .eslintrc.json, which the v9 CLI no longer
// reads; ESLint 8 is end-of-life and stopped receiving advisory fixes.
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

/** Globals available in every Node context this repo runs code in. */
const nodeGlobals = {
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  console: "readonly",
  performance: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  fetch: "readonly",
};

module.exports = tseslint.config(
  {
    ignores: ["out/**", "dist/**", ".vscode-test/**", "node_modules/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "import", format: ["camelCase", "PascalCase"] },
      ],
      curly: "warn",
      eqeqeq: "warn",
      semi: "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Build config and the mocha bootstrap are CommonJS.
    files: ["*.js", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...nodeGlobals, require: "readonly", module: "writable", __dirname: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      // The mocha stub deliberately shadows names that also exist as DOM globals.
      "no-redeclare": "off",
    },
  },
  {
    // Maintenance scripts are ESM.
    files: ["scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
);
