import { useCallback } from "react";
import type { KeyboardEvent } from "react";

/**
 * Arrow-key navigation for a tablist / radiogroup.
 *
 * Roving `tabIndex` alone is half a control: Tab reaches the group, but the
 * only way to move within it is the arrow keys, and without a handler they do
 * nothing — leaving the non-selected options unreachable from the keyboard.
 *
 * Home/End jump to the ends, matching the WAI-ARIA tabs and radio patterns.
 */
export function useRovingKeys<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (next: T) => void,
) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const index = values.indexOf(value);
    if (index < 0) { return; }

    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % values.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + values.length) % values.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = values.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = values[nextIndex];
    onChange(next);
    // Selection follows focus in both patterns, so move focus to match.
    const container = event.currentTarget;
    const options = container.querySelectorAll<HTMLElement>('[role="tab"],[role="radio"]');
    options[nextIndex]?.focus();
  }, [values, value, onChange]);
}
