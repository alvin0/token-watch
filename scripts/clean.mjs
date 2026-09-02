#!/usr/bin/env node
/**
 * Remove build output before a production package.
 *
 * `esbuild` overwrites what it emits but never removes what it no longer
 * emits, so a renamed or dropped bundle stayed in `dist/` and shipped.
 */
import { rmSync } from "node:fs";

for (const target of ["dist", "out"]) {
  rmSync(target, { recursive: true, force: true });
}
console.log("Cleaned dist/ and out/");
