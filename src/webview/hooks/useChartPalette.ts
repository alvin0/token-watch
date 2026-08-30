import { useEffect, useState } from "react";
import { resolveChartPalette, type ChartPalette } from "../theme";

/**
 * Chart colors from the active VS Code theme, re-read when the user switches
 * theme. VS Code rewrites the injected `:root` variables and the body class on
 * a theme change, so watching the body attributes is enough to pick it up.
 */
export function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState(resolveChartPalette);

  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(resolveChartPalette()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);

  return palette;
}
