import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { IngestConfig, SourceConfig } from "../shared/workerProtocol.js";
import type { PricingTable } from "../shared/types.js";
import { validatePricingTable } from "../shared/pricingValidation.js";
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
  retention: {
    /** Days of per-turn detail to keep; 0 keeps everything. */
    rawRecordDays: number;
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
      // Settings JSON is hand-edited and unchecked by VS Code beyond "object";
      // a negative or non-numeric rate would otherwise reach the cost maths.
      overrides: validatePricingOverrides(cfg.get<unknown>("pricing.overrides", {}), "settings"),
    },
    currency: {
      secondary: cfg.get<string>("currency.secondary", "") || "",
      secondaryRate: cfg.get<number>("currency.secondaryRate", 0),
    },
    ingestion: {
      watchDebounceMs: clamp(cfg.get<number>("ingestion.watchDebounceMs", 500), 250, 60000),
      maxLineBytes: Math.max(cfg.get<number>("ingestion.maxLineBytes", 1048576), 4096),
      backfillMonths: Math.max(cfg.get<number>("ingestion.backfillMonths", 0), 0),
    },
    retention: {
      rawRecordDays: Math.max(cfg.get<number>("retention.rawRecordDays", 0), 0),
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
    retention: cfg.retention,
    analytics: {
      anomalyMultiplier: cfg.analytics.anomalyMultiplier,
      contextFillWarnPct: cfg.analytics.contextFillWarnPct,
    },
  };
}

/** Name of the optional JSONC pricing file. */
export const PRICING_FILE_NAME = "pricing.config.jsonc";

/**
 * Load pricing overrides from `pricing.config.jsonc` in GLOBAL storage.
 *
 * The usage database lives in global storage and is shared by every VS Code
 * window, so its prices must not depend on which workspace happens to be open —
 * the same tokens would otherwise cost different amounts depending on the
 * window that ingested them. A file found in a workspace root is migrated into
 * global storage once, so existing setups keep working.
 *
 * The file supports JSONC (comments allowed).
 */
export function loadPricingFromFile(globalStoragePath?: string): PricingTable {
  if (globalStoragePath) {
    const globalFile = path.join(globalStoragePath, PRICING_FILE_NAME);
    const table = readPricingFile(globalFile);
    if (table) { return table; }

    const migrated = migrateWorkspacePricingFile(globalFile);
    if (migrated) { return migrated; }
    return {};
  }

  // No global storage path available (e.g. a unit context): fall back to the
  // workspace file rather than silently dropping the user's prices.
  return readWorkspacePricingFile()?.table ?? {};
}

/**
 * Validate a pricing table from an untrusted source, dropping bad entries and
 * reporting them once so a typo is visible rather than silently mispricing.
 */
export function validatePricingOverrides(raw: unknown, source: string): PricingTable {
  const { table, rejected } = validatePricingTable(raw);
  for (const rejection of rejected) {
    console.warn(`[TokenWatch] ignored pricing from ${source}: ${rejection.reason}`);
  }
  return table;
}

/** Merge user settings with the global pricing file. File entries win. */
export function effectivePricingOverrides(
  settings: PricingTable,
  globalStoragePath?: string,
): PricingTable {
  return { ...settings, ...loadPricingFromFile(globalStoragePath) };
}

function readWorkspacePricingFile(): { table: PricingTable; filePath: string } | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const filePath = path.join(folder.uri.fsPath, PRICING_FILE_NAME);
    const table = readPricingFile(filePath);
    if (table) { return { table, filePath }; }
  }
  return undefined;
}

/** One-time copy of a workspace pricing file into global storage. */
function migrateWorkspacePricingFile(globalFile: string): PricingTable | undefined {
  const workspaceFile = readWorkspacePricingFile();
  if (!workspaceFile) { return undefined; }
  try {
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.copyFileSync(workspaceFile.filePath, globalFile);
  } catch {
    // Copy is best-effort; the parsed table is still usable this session.
  }
  return workspaceFile.table;
}

function readPricingFile(filePath: string): PricingTable | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    const raw = fs.readFileSync(filePath, "utf8");
    // Strip JSONC comments (// and /* */)
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Same validation as the settings path: a hand-edited file is exactly
    // where a negative or misspelled rate comes from.
    const table = validatePricingOverrides(JSON.parse(stripped) as unknown, filePath);
    return Object.keys(table).length > 0 ? table : null;
  } catch {
    return null;
  }
}
