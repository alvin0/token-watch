/**
 * Regenerates the marketplace and activity bar icons from the corrected mark.
 *
 * The original artwork is 734x708, so every PNG cut from it carries a 3.6%
 * horizontal stretch and the dial reads as an oval. These are rendered from
 * resources/icons/token-watch.svg instead, whose ring is drawn as true arcs on
 * one radius inside a square viewBox.
 *
 * Run with: npm run build:icon-pngs
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const SOURCE = "resources/icons/token-watch.svg";
const SIZE = 128;
const MARK = 104;   // matches the inset the previous icons had
const INSET = Math.round((SIZE - MARK) / 2);

const svg = readFileSync(SOURCE, "utf8");
const render = (fill) => sharp(Buffer.from(svg.replace(/<path/g, `<path fill="${fill}"`)), { density: 900 })
  .resize(MARK, MARK, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const TARGETS = [
  {
    file: "resources/icon-marketplace.png",
    fill: "#101010",
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
  {
    file: "resources/icon-activitybar.png",
    fill: "#ffffff",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
];

for (const target of TARGETS) {
  const mark = await render(target.fill);
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: target.background } })
    .composite([{ input: mark, left: INSET, top: INSET }])
    .png()
    .toFile(target.file);

  // Report how round the result actually is, rather than assuming.
  const { data } = await sharp(target.file)
    .flatten({ background: target.fill === "#ffffff" ? "#000000" : "#ffffff" })
    .greyscale().resize(400, 400, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const lit = target.fill === "#ffffff" ? (v) => v > 128 : (v) => v < 128;
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      if (!lit(data[y * 400 + x])) { continue; }
      if (x < x0) { x0 = x; } if (x > x1) { x1 = x; }
      if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }
    }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  console.log(`${target.file.padEnd(34)} ${SIZE}x${SIZE}  muc ${w}x${h}  ty le ${(w / h).toFixed(4)}`);
}
