#!/usr/bin/env node
/**
 * Release gate for the packaged VSIX.
 *
 * A VSIX once shipped with the whole `.codegraph/` index inside — several MB of
 * raw development database, plus absolute paths from the machine that built it.
 * `.vscodeignore` now excludes it, but an ignore file is easy to regress, so
 * the packaged artefact itself is checked.
 *
 * Usage: node scripts/check-vsix.mjs [path/to/token-watch.vsix]
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/** Entries that must never ship, matched against the VSIX's internal paths. */
const FORBIDDEN = [
  { pattern: /(^|\/)\.codegraph\//i, reason: "CodeGraph index (development artefact, leaks local paths)" },
  { pattern: /(^|\/)scripts\//i, reason: "build/benchmark scripts" },
  { pattern: /(^|\/)\.agents\//i, reason: "agent configuration" },
  { pattern: /(^|\/)\.kiro\//i, reason: "editor scratch directory" },
  { pattern: /(^|\/)\.git\//i, reason: "git metadata" },
  { pattern: /(^|\/)src\//i, reason: "TypeScript sources" },
  { pattern: /(^|\/)out\//i, reason: "compiled test output" },
  { pattern: /(^|\/)node_modules\//i, reason: "dependencies (everything is bundled)" },
  { pattern: /(^|\/)pricing\.config\.jsonc$/i, reason: "sample pricing config" },
  { pattern: /(^|\/)issue\.md$/i, reason: "internal notes" },
  { pattern: /(^|\/)eslint\.config\.js$/i, reason: "lint configuration" },
  { pattern: /(^|\/)\.mocharc\.json$/i, reason: "test-runner configuration" },
  { pattern: /(^|\/)esbuild\.js$/i, reason: "build configuration" },
  { pattern: /\.map$/i, reason: "source maps" },
  { pattern: /\.vsix$/i, reason: "nested VSIX" },
];

/** What a release is allowed to contain. Anything else fails the build. */
const ALLOWED = [
  /^extension\.vsixmanifest$/i,
  /^\[Content_Types\]\.xml$/i,
  /^extension\/package\.json$/i,
  /^extension\/(readme|changelog|license)(\.[a-z]+)?$/i,
  /^extension\/dist\/[\w.-]+\.(js|css|wasm)$/i,
  /^extension\/resources\/[\w.-]+\.(png|woff|woff2|svg)$/i,
];

/** Ceiling for the packed artefact; a jump means something large slipped in. */
const MAX_BYTES = 4 * 1024 * 1024;

const vsixPath = process.argv[2] ?? "token-watch.vsix";
if (!existsSync(vsixPath)) {
  fail(`VSIX not found: ${vsixPath}`);
}

let listing;
try {
  listing = execFileSync("npx", ["--no-install", "vsce", "ls-files", "--packagePath", vsixPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  // `vsce ls-files` is not available in every version; fall back to reading the
  // zip central directory ourselves.
  listing = (await listZipEntries(vsixPath)).join("\n");
}

const entries = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (entries.length === 0) {
  fail("Could not read any entries from the VSIX");
}

const problems = [];
for (const entry of entries) {
  const normalized = entry.replace(/^extension\//, "");
  const denial = FORBIDDEN.find(({ pattern }) => pattern.test(normalized));
  if (denial) {
    problems.push(`${entry} — ${denial.reason}`);
    continue;
  }
  // The denylist catches what has leaked before; the allowlist catches what
  // nobody has thought of yet, so a new stray file has to be considered rather
  // than shipped by default.
  if (!ALLOWED.some((pattern) => pattern.test(entry))) {
    problems.push(`${entry} — not on the allowlist; add it to scripts/check-vsix.mjs if it belongs in a release`);
  }
}

const size = statSync(vsixPath).size;
if (size > MAX_BYTES) {
  problems.push(`package is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB ceiling`);
}

if (problems.length > 0) {
  console.error("VSIX contains files that must not ship:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`VSIX OK: ${entries.length} entries, ${(size / 1024 / 1024).toFixed(2)} MB`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Minimal zip central-directory reader — enough to list entry names. */
async function listZipEntries(path) {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(path);
  const names = [];
  // Central directory file header signature.
  const signature = 0x02014b50;
  for (let offset = 0; offset <= buffer.length - 46; offset++) {
    if (buffer.readUInt32LE(offset) !== signature) { continue; }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    names.push(name);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}
