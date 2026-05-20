/**
 * RFC-0025 §13.1 quality-monitoring.yaml config loader (Phase 3 / AISDLC-304).
 *
 * Per-org configurable via `.ai-sdlc/quality-monitoring.yaml`. Ships
 * defaults calibrated for small-to-medium dogfood teams per §13.1.
 *
 * This module covers the subset of the §13.1 config schema that Phase 3
 * ships: specifically the `recurrence-windows` list (OQ-3). Remaining
 * config surfaces (OQ-1 thresholds, OQ-2 severity weights, OQ-4
 * attribution, OQ-7 sampling, OQ-9 AFK filter, OQ-10 namespace
 * enforcement) ship in subsequent Refit phases (AISDLC-303..307).
 *
 * The parser is a simple line-based reader — the same pattern as
 * `dor-config.ts` — to avoid pulling in `js-yaml` for a small, flat
 * config surface. The schema validator in CI catches malformed files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Defaults ──────────────────────────────────────────────────────────

/**
 * Default recurrence windows: 7d (flap), 30d (standard), 90d (legacy).
 * Matches §13.1 shipping defaults per OQ-3 resolution (2026-05-15).
 */
export const DEFAULT_RECURRENCE_WINDOWS: readonly string[] = Object.freeze(['7d', '30d', '90d']);

// ── Config types ──────────────────────────────────────────────────────

export interface QualityMonitoringConfig {
  /**
   * Recurrence windows to compute simultaneously (OQ-3).
   *
   * Each window is a duration string matching `\d+d` (e.g. `'7d'`,
   * `'30d'`, `'90d'`). The framework computes all windows in a single
   * pass so the operator sees flap-detection (7d), standard recurrence
   * (30d), and legacy-regression (90d) simultaneously.
   *
   * Per-org override: set `quality.recurrence-windows` in
   * `.ai-sdlc/quality-monitoring.yaml`.
   */
  recurrenceWindows: string[];
}

export const QUALITY_MONITORING_CONFIG_DEFAULTS: Readonly<QualityMonitoringConfig> = {
  recurrenceWindows: [...DEFAULT_RECURRENCE_WINDOWS],
};

// ── Parsing helpers ───────────────────────────────────────────────────

/**
 * Parse a duration string like `'7d'`, `'30d'`, `'90d'` into a day count.
 * Returns `null` for unrecognized formats.
 */
export function parseDurationDays(window: string): number | null {
  const match = /^(\d+)d$/i.exec(window.trim());
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

/**
 * Parse the subset of `quality-monitoring.yaml` relevant to Phase 3
 * (the `recurrence-windows` list under `quality:`).
 *
 * Supported YAML shape:
 * ```yaml
 * quality:
 *   recurrence-windows:
 *     - 7d
 *     - 30d
 *     - 90d
 * ```
 *
 * Anything else is silently ignored — the schema validator in CI enforces
 * the full shape. If the list is present but contains no valid window
 * strings, falls back to the shipping defaults so the caller always has
 * at least one window to compute.
 */
export function parseQualityMonitoringConfigYaml(raw: string): QualityMonitoringConfig {
  const out: QualityMonitoringConfig = { ...QUALITY_MONITORING_CONFIG_DEFAULTS };

  const lines = raw.split('\n');
  let inRecurrenceWindows = false;
  const parsedWindows: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Detect `recurrence-windows:` key (top-level or under `quality:`)
    if (/^recurrence-windows\s*:/.test(trimmed)) {
      inRecurrenceWindows = true;
      parsedWindows.length = 0;
      continue;
    }

    if (inRecurrenceWindows) {
      // Collect list items
      const listMatch = /^-\s*(.+)$/.exec(trimmed);
      if (listMatch && listMatch[1]) {
        const val = listMatch[1].trim().replace(/['"]/g, '');
        if (/^\d+d$/i.test(val)) {
          parsedWindows.push(val.toLowerCase());
        }
        continue;
      }
      // Non-list line exits the block
      if (!trimmed.startsWith('-')) {
        inRecurrenceWindows = false;
      }
    }
  }

  if (parsedWindows.length > 0) {
    out.recurrenceWindows = parsedWindows;
  }

  return out;
}

// ── Loader ────────────────────────────────────────────────────────────

export interface LoadQualityMonitoringConfigOpts {
  /** Project root. Config path = `<workDir>/.ai-sdlc/quality-monitoring.yaml`. */
  workDir?: string;
  /** Explicit config file path override (useful in tests). */
  filePath?: string;
}

/**
 * Load the per-org quality monitoring config.
 *
 * Resolution order:
 * 1. `opts.filePath` (explicit override)
 * 2. `<opts.workDir>/.ai-sdlc/quality-monitoring.yaml`
 * 3. `<process.cwd()>/.ai-sdlc/quality-monitoring.yaml`
 *
 * Missing file → shipping defaults. Malformed file → shipping defaults.
 */
export function loadQualityMonitoringConfig(
  opts: LoadQualityMonitoringConfigOpts = {},
): QualityMonitoringConfig {
  const filePath =
    opts.filePath ?? join(opts.workDir ?? process.cwd(), '.ai-sdlc', 'quality-monitoring.yaml');

  if (!existsSync(filePath)) {
    return { ...QUALITY_MONITORING_CONFIG_DEFAULTS };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ...QUALITY_MONITORING_CONFIG_DEFAULTS };
  }

  return parseQualityMonitoringConfigYaml(raw);
}
