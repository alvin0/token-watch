const esbuild = require("esbuild");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Logs esbuild problems in a format VS Code's problem matcher understands.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`[ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

/** Run PostCSS (Tailwind) to generate dist/webview.css */
function buildCss() {
  execSync(
    `npx postcss ${path.join("src", "webview", "index.css")} -o ${path.join("dist", "webview.css")}`,
    { stdio: "inherit" }
  );
}

/** Copy sql-wasm.wasm into dist/ */
function copyWasm() {
  fs.copyFileSync(
    path.join("node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join("dist", "sql-wasm.wasm")
  );
}

async function main() {
  // --- Extension host bundle (Node.js) ---
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  // --- WebView bundle (browser) ---
  const webviewCtx = await esbuild.context({
    entryPoints: ["src/webview/main.tsx"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/webview.js",
    // CSS is handled by PostCSS/Tailwind separately
    loader: { ".css": "empty" },
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  // --- Worker bundle (Node.js) ---
  const workerCtx = await esbuild.context({
    entryPoints: ["src/worker/ingestionWorker.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/ingestionWorker.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    buildCss();
    copyWasm();
    await Promise.all([extensionCtx.watch(), webviewCtx.watch(), workerCtx.watch()]);
  } else {
    buildCss();
    copyWasm();
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await workerCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
    await workerCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
