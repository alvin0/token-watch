/**
 * Builds the icon font behind the status bar glyphs.
 *
 * VS Code status bar entries render text and codicons only, so a custom logo
 * has to arrive as a font glyph contributed through `contributes.icons`. This
 * turns resources/icons/*.svg into one WOFF, keeping the code points stable so
 * package.json does not have to change when the artwork does.
 *
 * Run with: npm run build:icons
 */
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SVGIcons2SVGFontStream } from "svgicons2svgfont";
import svg2ttf from "svg2ttf";
import ttf2woff from "ttf2woff";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "resources", "icons");
const outFile = join(root, "resources", "token-watch-icons.woff");

/** Icon id in package.json → source file and its private-use code point. */
const ICONS = [
  { name: "token-watch", file: "token-watch.svg", codepoint: 0xe900 },
  { name: "token-watch-codex", file: "codex.svg", codepoint: 0xe901 },
  { name: "token-watch-claude", file: "claude.svg", codepoint: 0xe902 },
];

const FONT_HEIGHT = 1000;

const svgFont = await new Promise((resolve, reject) => {
  const chunks = [];
  const stream = new SVGIcons2SVGFontStream({
    fontName: "token-watch-icons",
    fontHeight: FONT_HEIGHT,
    normalize: true,
    centerHorizontally: true,
    log: () => undefined,
  });

  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
  stream.on("error", reject);

  for (const icon of ICONS) {
    const glyph = createReadStream(join(iconsDir, icon.file));
    glyph.metadata = {
      name: icon.name,
      unicode: [String.fromCodePoint(icon.codepoint)],
    };
    stream.write(glyph);
  }
  stream.end();
});

const ttf = svg2ttf(svgFont, { description: "Token Watch status bar icons" });
const woff = ttf2woff(new Uint8Array(ttf.buffer));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.from(woff.buffer));

for (const icon of ICONS) {
  const source = readFileSync(join(iconsDir, icon.file), "utf8");
  const paths = (source.match(/<path\b/g) ?? []).length;
  console.log(`  ${icon.name.padEnd(20)} U+${icon.codepoint.toString(16).toUpperCase()}  ${paths} path(s)  ${icon.file}`);
}
console.log(`\nWrote ${outFile} (${(woff.buffer.byteLength / 1024).toFixed(1)} KB)`);
