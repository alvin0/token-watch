/**
 * Builds resources/icons/token-watch.svg from the master artwork.
 *
 * The interior of the mark (needle, hub, pixel grid, inner arcs, bars) is traced
 * from the bitmap so it keeps its exact character. The outer ring is NOT traced:
 * in the master art its radius drifts with direction, the gap at the bottom is
 * cut off-centre, and a few pixel-grid squares spill past it. So everything from
 * RING_MASK outwards is erased before tracing, and the ring is redrawn here as
 * true arcs on one radius, with the gaps square on the vertical axis.
 *
 * Run with: npm run trace:logo
 */
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import Jimp from "jimp";
import potrace from "potrace";

const SOURCE = "resources/Untitled - May 21, 2026 at 14.46.16-trim.png";
const OUTPUT = "resources/icons/token-watch.svg";

/** Measured off the master art: centre of the dial and the ring's own band. */
const CENTER = { x: 388, y: 356 };
const RING = { mid: 340, stroke: 28 };
const RING_MASK = RING.mid - RING.stroke / 2;   // cut the interior exactly at the ring
const OUTER_ZONE = 300;                         // shapes living only past this are dropped
const CLIP_KEEP = 1500;                         // a shape cut by the ring must be at least this big to survive

/**
 * Ring segments, in degrees measured counter-clockwise from east. Taken from the
 * master art, with the two gaps squared onto the vertical axis so the bottom of
 * the dial is symmetric instead of stepped.
 */
const SOLID_ARCS = [[52, 87], [93, 154], [193, 267], [273, 323]];
const LONE_DASH = [175, 181];
const DASH_ARC = { from: 328, to: 407, count: 9, dash: 6 };

const image = await Jimp.read(SOURCE);
const { width: W, height: H } = image.bitmap;

// Erase everything from the new ring's inner edge outwards. The needle runs into
// the ring in the master art, so it is cut exactly where the redrawn ring starts
// and the two still meet flush.
const ink = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const { r, g, b, a } = Jimp.intToRGBA(image.getPixelColor(x, y));
    const luma = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    ink[y * W + x] = luma < 128 && Math.hypot(x - CENTER.x, y - CENTER.y) < RING_MASK ? 1 : 0;
  }
}

// A few pixel-grid squares sit out past the ring. What the cut leaves of them is
// a stump floating in the outer zone, so drop any shape lying wholly out there.
// Shapes that also reach inward (the bars, the arcs) are untouched.
const seen = new Uint8Array(W * H);
let removed = 0;
for (let start = 0; start < W * H; start++) {
  if (!ink[start] || seen[start]) { continue; }
  const pixels = [start];
  const stack = [start];
  seen[start] = 1;
  let minRadius = Infinity;
  let maxRadius = 0;
  let area = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    minRadius = Math.min(minRadius, Math.hypot(x - CENTER.x, y - CENTER.y));
    maxRadius = Math.max(maxRadius, Math.hypot(x - CENTER.x, y - CENTER.y));
    area++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) { continue; }
      const q = ny * W + nx;
      if (ink[q] && !seen[q]) { seen[q] = 1; pixels.push(q); stack.push(q); }
    }
  }
  // The old ring wandered in and out of the cut, leaving slivers, and it clipped
  // one grid square in half. Anything small that touches the cut is that debris.
  if (minRadius >= OUTER_ZONE || (maxRadius >= RING_MASK - 2 && area < CLIP_KEEP)) {
    removed++;
    for (const p of pixels) { ink[p] = 0; }
  }
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!ink[y * W + x]) { image.setPixelColor(0xffffffff, x, y); }
  }
}

const traced = await promisify(potrace.trace)(image, {
  threshold: 128,
  turdSize: 2,
  alphaMax: 0.2,      // low, so the square pixel grid keeps sharp corners
  optCurve: true,
  optTolerance: 0.2,
});

const point = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [CENTER.x + r * Math.cos(a), CENTER.y - r * Math.sin(a)];
};
const fmt = (n) => Number(n.toFixed(2));

/** One annulus sector. Outer edge runs counter-clockwise, inner edge back, so
 *  the two wind opposite ways and the band fills under the non-zero rule. */
function sector(from, to) {
  const rOuter = RING.mid + RING.stroke / 2;
  const rInner = RING.mid - RING.stroke / 2;
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const [ox0, oy0] = point(rOuter, from), [ox1, oy1] = point(rOuter, to);
  const [ix1, iy1] = point(rInner, to), [ix0, iy0] = point(rInner, from);
  return `M${fmt(ox0)} ${fmt(oy0)}`
    + `A${rOuter} ${rOuter} 0 ${large} 0 ${fmt(ox1)} ${fmt(oy1)}`
    + `L${fmt(ix1)} ${fmt(iy1)}`
    + `A${rInner} ${rInner} 0 ${large} 1 ${fmt(ix0)} ${fmt(iy0)}Z`;
}

const ringParts = [...SOLID_ARCS, LONE_DASH].map(([a, b]) => sector(a, b));
const step = (DASH_ARC.to - DASH_ARC.from) / DASH_ARC.count;
for (let i = 0; i < DASH_ARC.count; i++) {
  const start = DASH_ARC.from + i * step + (step - DASH_ARC.dash) / 2;
  ringParts.push(sector(start, start + DASH_ARC.dash));
}

const interior = traced.match(/ d="([^"]*)"/)[1];
const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(traced) ?? [, "734", "708"];

// Centre a square viewBox on the dial itself, so the ring sits dead centre and
// a non-square canvas cannot squash it when the glyph is fitted to the em box.
const half = RING.mid + RING.stroke / 2 + 8;
const view = { x: CENTER.x - half, y: CENTER.y - half, size: half * 2 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.size)} ${fmt(view.size)}">\n`
  + `  <!-- Interior traced from ${SOURCE}; ring redrawn as exact arcs. Built by scripts/trace-logo.mjs, do not hand-edit. -->\n`
  + `  <path d="${interior}"/>\n`
  + `  <path d="${ringParts.join("")}"/>\n`
  + `</svg>\n`;

writeFileSync(OUTPUT, svg);
console.log(`nguon ${w}x${h} -> viewBox vuong ${fmt(view.size)}`);
console.log(`  ruot: ${(interior.match(/M/gi) ?? []).length} contour traced, da xoa ${removed} hinh cham vao vanh`);
console.log(`  vanh: ${ringParts.length} cung ve chinh xac tai r=${RING.mid}, day ${RING.stroke}`);
console.log(`-> ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB)`);
