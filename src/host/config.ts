import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { IngestConfig, SourceConfig } from "../shared/workerProtocol.js";
import type { PricingTable, ModelRate } from "../shared/types.js";
import type { DisplayCurrencyConfig } from "../shared/protocol.js";

export interface TokenWatchConfig {
  sources: {
    codex: SourceConfig;
    claude: SourceConfig;
  };
  pricing: {
    overrides: PricingTable;
  };
  currency: DisplayCurrencyConfig;
  ingestion: {
    watchDebounceMs: number;
    maxLineBytes: number;
    backfillMonths: number;
  };
  analytics: {
    anomalyMultiplier: number;
    contextFillWarnPct: number;
  };
  statusBar: {
    enabled: boolean;
  };
}

/** Clamp `value` to `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Read and validate the full tokenWatch configuration from VS Code settings.
 * Applies range validation and defaults for out-of-range values.
 */
export function getConfig(): TokenWatchConfig {
  const cfg = vscode.workspace.getConfiguration("tokenWatch");

  return {
    sources: {
      codex: {
        enabled: cfg.get<boolean>("sources.codex.enabled", true),
        path: cfg.get<string>("sources.codex.path", ""),
      },
      claude: {
        enabled: cfg.get<boolean>("sources.claude.enabled", true),
        path: cfg.get<string>("sources.claude.path", ""),
      },
    },
    pricing: {
      overrides: cfg.get<PricingTable>("pricing.overrides", {}),
    },
    currency: {
      secondary: cfg.get<string>("currency.secondary", "") || "",
      secondaryRate: cfg.get<number>("currency.secondaryRate", 0),
    },
    ingestion: {
      watchDebounceMs: clamp(cfg.get<number>("ingestion.watchDebounceMs", 500), 250, 60000),
      maxLineBytes: Math.max(cfg.get<number>("ingestion.maxLineBytes", 1048576), 4096),
      backfillMonths: Math.max(cfg.get<number>("ingestion.backfillMonths", 6), 0),
    },
    analytics: {
      anomalyMultiplier: Math.max(cfg.get<number>("analytics.anomalyMultiplier", 2), 1),
      contextFillWarnPct: clamp(cfg.get<number>("analytics.contextFillWarnPct", 80), 0, 100),
    },
    statusBar: {
      enabled: cfg.get<boolean>("statusBar.enabled", true),
    },
  };
}

/**
 * Convert the typed config into the IngestConfig shape expected by the worker.
 * Resolves default paths when the user-configured path is empty.
 */
export function toIngestConfig(cfg: TokenWatchConfig): IngestConfig {
  const home = os.homedir();
  return {
    sources: {
      codex: {
        enabled: cfg.sources.codex.enabled,
        path: cfg.sources.codex.path || path.join(home, ".codex", "sessions"),
      },
      claude: {
        enabled: cfg.sources.claude.enabled,
        path: cfg.sources.claude.path || path.join(home, ".claude", "projects"),
      },
    },
    pricingOverrides: cfg.pricing.overrides,
    currency: cfg.currency,
    ingestion: {
      watchDebounceMs: cfg.ingestion.watchDebounceMs,
      maxLineBytes: cfg.ingestion.maxLineBytes,
      backfillMonths: cfg.ingestion.backfillMonths,
    },
    analytics: {
      anomalyMultiplier: cfg.analytics.anomalyMultiplier,
      contextFillWarnPct: cfg.analytics.contextFillWarnPct,
    },
  };
}

/**
 * Load pricing overrides from `pricing.config.jsonc` in the workspace root.
 * Falls back to VS Code settings `tokenWatch.pricing.overrides` if file not found.
 * The file supports JSONC (comments allowed).
 */
export function loadPricingFromFile(): PricingTable {
  // Try workspace root first
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      const filePath = path.join(folder.uri.fsPath, "pricing.config.jsonc");
      const table = readPricingFile(filePath);
      if (table) { return table; }
    }
  }

  // Try extension install directory
  return {};
}

function readPricingFile(filePath: string): PricingTable | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    const raw = fs.readFileSync(filePath, "utf8");
    // Strip JSONC comments (// and /* */)
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const parsed = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null) { return null; }

    // Extract valid model rates, skip $-prefixed meta keys except $fallback
    const table: PricingTable = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("$") && key !== "$fallback") { continue; }
      if (typeof value === "object" && value !== null) {
        const rate = value as ModelRate;
        if (key === "$fallback") {
          // Store fallback under a special key the engine can use
          table["$fallback"] = rate;
        } else {
          table[key] = rate;
        }
      }
    }
    return Object.keys(table).length > 0 ? table : null;
  } catch {
    return null;
  }
}
