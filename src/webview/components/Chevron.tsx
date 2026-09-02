/**
 * Disclosure chevron for "show more" / "show less" toggles. Drawn as an SVG
 * rather than the ⌄/⌃ glyphs, which sit off the text baseline in most fonts
 * and left the arrow visually misaligned with its label.
 */
export function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`tw-h-2.5 tw-w-2.5 tw-shrink-0 tw-fill-none tw-stroke-current ${up ? "tw-rotate-180" : ""}`}
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 9 7 7 7-7" />
    </svg>
  );
}
