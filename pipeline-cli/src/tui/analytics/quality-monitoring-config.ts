/**
 * RFC-0025 §13.1 quality-monitoring.yaml config loader.
 * Phase 3 (AISDLC-304): recurrence-windows.
 * Phase 5 (AISDLC-306): coverage-gap (OQ-6) + determinism-detection (OQ-7)
 * + operator-time-cost (OQ-9) per-org configuration.
 * Phase 6 (AISDLC-307): upstream-reporting (OQ-5) + vendor-namespace
 * (OQ-10) — strict enforcement on resource load for custom subclasses.
 *
 * Per-org configurable via `.ai-sdlc/quality-monitoring.yaml`. Ships
 * defaults calibrated for small-to-medium dogfood teams per §13.1.
 *
 * The parser remains a simple line-based reader — the same pattern as
 * `dor-config.ts` — to avoid pulling in `js-yaml` for a small, flat
 * config surface. The schema validator in CI catches malformed files.
 *
 * **OQ-10 strict enforcement (Phase 6):** when `customSubclasses` are
 * declared in the YAML, every entry is run through
 * `validateVendorNamespace()`. On the default `enforce: reject` setting
 * an un-namespaced custom subclass raises `QualityMonitoringConfigError`
 * at load time so the resource cannot be loaded with an illegal name.
 * Adopters who set `vendor-namespace.enforce: warn` log a warning but
 * load; `enforce: none` skips the check entirely. Both `warn` and
 * `none` are deprecated per §13.1 (operator-affirmed OQ-10, 2026-05-15).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateVendorNamespace } from './quality-classifier.js';

// ── Defaults ──────────────────────────────────────────────────────────

/**
 * Default recurrence windows: 7d (flap), 30d (standard), 90d (legacy).
 * Matches §13.1 shipping defaults per OQ-3 resolution (2026-05-15).
 */
export const DEFAULT_RECURRENCE_WINDOWS: readonly string[] = Object.freeze(['7d', '30d', '90d']);

/**
 * Default upstream reporting template path. Adopters override via
 * `quality.upstream-reporting.prefilledIssueTemplate` per OQ-5.
 */
export const DEFAULT_UPSTREAM_TEMPLATE_PATH = '.ai-sdlc/templates/framework-bug-report.md';

/**
 * Vendor-namespace enforcement modes per OQ-10.
 * `reject` is the operator-affirmed default; `warn` and `none` are
 * deprecated for adopter convenience during migration.
 */
export type VendorNamespaceEnforce = 'reject' | 'warn' | 'none';

export const DEFAULT_VENDOR_NAMESPACE_ENFORCE: VendorNamespaceEnforce = 'reject';

/**
 * Default coverage-gap auto-quarantine flag per OQ-6 §13.1 (2026-05-15).
 * When true, an unmatched failure mode (`framework-coverage-gap`) auto-
 * quarantines the affected dispatch alongside the capture record.
 */
export const DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE = true;

/**
 * Default coverage-gap file-capture flag per OQ-6 §13.1 (2026-05-15).
 * When true, an unmatched failure mode writes an RFC-0024 capture record
 * with `source: framework-coverage-gap` + `triage: tbd`.
 */
export const DEFAULT_COVERAGE_GAP_FILE_CAPTURE = true;

/**
 * Default determinism-detection sample rate per OQ-7 §13.1 (2026-05-15).
 * 1-in-50 baseline sampling for tasks without `requires-determinism: true`
 * and outside the top-decile blast-radius cohort.
 */
export const DEFAULT_DETERMINISM_SAMPLE_RATE = 0.02;

/**
 * Default top-decile blast-radius always-on flag per OQ-7. When true,
 * tasks whose `effectivePriority` puts them in the top-decile of the
 * RFC-0014 dep-graph snapshot are always sampled for determinism, on top
 * of the flat sample rate.
 */
export const DEFAULT_DETERMINISM_ALWAYS_ON_TOP_BLAST_DECILE = true;

/**
 * Default always-on for `requires-determinism: true` tasks per OQ-7.
 * Always true — the explicit task opt-in must always sample.
 */
export const DEFAULT_DETERMINISM_ALWAYS_ON_REQUIRES = true;

/**
 * Default AFK inactivity threshold in minutes for operator-time-cost per
 * OQ-9 §13.1. Gaps between events within a blocked span that exceed this
 * threshold are zeroed out as "operator walked away" noise.
 */
export const DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES = 30;

// ── Config types ──────────────────────────────────────────────────────

export interface UpstreamReportingConfig {
  /**
   * Upstream framework repo URL (e.g. `https://github.com/ai-sdlc-framework/ai-sdlc`).
   * Adopters override per their framework version; empty string disables
   * the report-upstream UX (`cli-quality report-upstream` errors clearly).
   */
  repoUrl: string;
  /**
   * Template path used to render the pre-filled issue body. Relative to
   * the project root (or absolute). Default
   * `.ai-sdlc/templates/framework-bug-report.md` per §13.1.
   */
  prefilledIssueTemplate: string;
}

export interface VendorNamespaceConfig {
  /**
   * Strict / lenient / off enforcement of OQ-10 vendor-namespace rule
   * for custom failure-mode subclasses. Default `reject` (strict).
   */
  enforce: VendorNamespaceEnforce;
}

/**
 * RFC-0025 §13.1 OQ-6 — coverage-gap response.
 *
 * Phase 5 (AISDLC-306). Controls the framework-coverage-gap auto-quarantine
 * + capture-write behavior when an uncatalogued failure-mode escapes the
 * playbook (i.e. `UnknownFailureMode` fall-through).
 */
export interface CoverageGapConfig {
  /**
   * When true (default), an uncatalogued failure mode auto-quarantines the
   * affected dispatch (rollback's existing quarantine path is honored).
   * When false, the operator is responsible for triggering remediation.
   */
  autoQuarantine: boolean;
  /**
   * When true (default), an uncatalogued failure mode writes an RFC-0024
   * capture record (`source: framework-coverage-gap`, `triage: tbd`).
   * Operator triages via the existing RFC-0024 rubric (§7).
   */
  fileCapture: boolean;
}

/**
 * RFC-0025 §13.1 OQ-7 — composite determinism-detection.
 *
 * Phase 5 (AISDLC-306). Controls the composite sampling for
 * `framework-determinism-violated` detection — flat sample rate, always-on
 * for `requires-determinism: true` tasks, always-on for top-decile blast-
 * radius tasks (composes with RFC-0014 dep-graph snapshot).
 */
export interface DeterminismDetectionConfig {
  /**
   * Default sample rate as a fraction (0..1). `0.02` = 1-in-50 dispatches
   * per the OQ-7 baseline. Operators override per-org for noisier corpora.
   */
  defaultSampleRate: number;
  /**
   * Always sample tasks with `requires-determinism: true` in their
   * frontmatter. True by default (explicit opt-in must always sample).
   */
  alwaysOnRequiresDeterminism: boolean;
  /**
   * Always sample tasks in the top-decile blast-radius cohort (composes
   * with RFC-0014 dep-graph snapshot's `effectivePriority`). True by
   * default — risk-based concentration matches the framework's
   * deterministic-first preflight ladder (RFC-0035 §5).
   */
  alwaysOnTopBlastRadiusDecile: boolean;
}

/**
 * RFC-0025 §13.1 OQ-9 — operator-time-cost instrumentation.
 *
 * Phase 5 (AISDLC-306). Controls the AFK noise filter applied when
 * computing active-cost from RFC-0015 `events.jsonl`.
 */
export interface OperatorTimeCostConfig {
  /**
   * AFK inactivity threshold in minutes. Gaps between consecutive events
   * within a blocked span that exceed this threshold are excluded from the
   * active-cost computation. Default `30` per §13.1 / OQ-9 resolution.
   */
  afkInactivityMinutes: number;
}

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
  /**
   * Operator-initiated upstream reporting (OQ-5). See `UpstreamReportingConfig`.
   */
  upstreamReporting: UpstreamReportingConfig;
  /**
   * Vendor-namespace enforcement (OQ-10) for custom failure-mode
   * subclasses. See `VendorNamespaceConfig`.
   */
  vendorNamespace: VendorNamespaceConfig;
  /**
   * Adopter-declared custom failure-mode subclasses. Each entry MUST
   * be vendor-namespaced under the default `reject` enforcement; the
   * loader rejects illegal names at load time. Empty by default.
   */
  customSubclasses: string[];
  /**
   * Coverage-gap response (OQ-6 / Phase 5). See `CoverageGapConfig`.
   */
  coverageGap: CoverageGapConfig;
  /**
   * Composite determinism-detection sampling (OQ-7 / Phase 5). See
   * `DeterminismDetectionConfig`.
   */
  determinismDetection: DeterminismDetectionConfig;
  /**
   * Operator-time-cost instrumentation (OQ-9 / Phase 5). See
   * `OperatorTimeCostConfig`.
   */
  operatorTimeCost: OperatorTimeCostConfig;
}

export const QUALITY_MONITORING_CONFIG_DEFAULTS: Readonly<QualityMonitoringConfig> = Object.freeze({
  recurrenceWindows: [...DEFAULT_RECURRENCE_WINDOWS],
  upstreamReporting: {
    repoUrl: '',
    prefilledIssueTemplate: DEFAULT_UPSTREAM_TEMPLATE_PATH,
  },
  vendorNamespace: {
    enforce: DEFAULT_VENDOR_NAMESPACE_ENFORCE,
  },
  customSubclasses: [],
  coverageGap: {
    autoQuarantine: DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
    fileCapture: DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
  },
  determinismDetection: {
    defaultSampleRate: DEFAULT_DETERMINISM_SAMPLE_RATE,
    alwaysOnRequiresDeterminism: DEFAULT_DETERMINISM_ALWAYS_ON_REQUIRES,
    alwaysOnTopBlastRadiusDecile: DEFAULT_DETERMINISM_ALWAYS_ON_TOP_BLAST_DECILE,
  },
  operatorTimeCost: {
    afkInactivityMinutes: DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES,
  },
});

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Raised when the config file violates a load-time invariant — e.g. a
 * declared custom subclass that fails the OQ-10 vendor-namespace rule
 * under `enforce: reject`. Catchable so the CLI / loader callers can
 * surface a clear actionable message to the operator.
 */
export class QualityMonitoringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityMonitoringConfigError';
  }
}

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

/** Strip surrounding single/double quotes from a YAML scalar. */
function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Parse the subset of `quality-monitoring.yaml` relevant to Phases 3+5+6.
 *
 * Supported YAML shape (each block independent / optional):
 * ```yaml
 * quality:
 *   recurrence-windows:        # OQ-3
 *     - 7d
 *     - 30d
 *     - 90d
 *
 *   upstream-reporting:        # OQ-5
 *     repoUrl: "https://github.com/org/repo"
 *     prefilledIssueTemplate: ".ai-sdlc/templates/framework-bug-report.md"
 *
 *   coverage-gap:              # OQ-6 / Phase 5 (AISDLC-306)
 *     autoQuarantine: true
 *     fileCapture: true
 *
 *   determinism-detection:     # OQ-7 / Phase 5 (AISDLC-306)
 *     defaultSampleRate: 0.02
 *     alwaysOnRequiresDeterminism: true
 *     alwaysOnTopBlastRadiusDecile: true
 *
 *   operator-time-cost:        # OQ-9 / Phase 5 (AISDLC-306)
 *     afkInactivityMinutes: 30
 *
 *   vendor-namespace:          # OQ-10
 *     enforce: reject          # or warn / none (deprecated)
 *
 *   customSubclasses:          # OQ-10 — declared at adopter resource-load time
 *     - acme-corp:custom-gate-faulty
 *     - acme-corp:billing-timeout
 * ```
 *
 * Anything else is silently ignored — the schema validator in CI enforces
 * the full shape. If a list is present but contains no valid entries,
 * falls back to the shipping defaults so the caller always has at least
 * one usable value.
 */
export function parseQualityMonitoringConfigYaml(raw: string): QualityMonitoringConfig {
  const out: QualityMonitoringConfig = {
    recurrenceWindows: [...DEFAULT_RECURRENCE_WINDOWS],
    upstreamReporting: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.upstreamReporting },
    vendorNamespace: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.vendorNamespace },
    customSubclasses: [],
    coverageGap: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap },
    determinismDetection: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection },
    operatorTimeCost: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.operatorTimeCost },
  };

  const lines = raw.split('\n');

  // Track the active block; resets when we hit a non-list line at a
  // shallower indent. The line-oriented parser is intentionally minimal —
  // see the module docstring for rationale.
  type Block =
    | 'recurrence-windows'
    | 'upstream-reporting'
    | 'vendor-namespace'
    | 'customSubclasses'
    | 'coverage-gap'
    | 'determinism-detection'
    | 'operator-time-cost'
    | null;
  let block: Block = null;
  let parsedWindows: string[] = [];
  let parsedSubclasses: string[] = [];

  const flushWindows = (): void => {
    if (parsedWindows.length > 0) out.recurrenceWindows = parsedWindows;
    parsedWindows = [];
  };
  const flushSubclasses = (): void => {
    out.customSubclasses = parsedSubclasses;
    parsedSubclasses = [];
  };

  // Parse a YAML scalar as a boolean per common YAML truthiness rules.
  // Returns null when the scalar is not boolean-shaped.
  const parseBool = (val: string): boolean | null => {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === 'on') return true;
    if (lower === 'false' || lower === 'no' || lower === 'off') return false;
    return null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // ── Block headers (level-agnostic key match) ──────────────────────
    if (/^recurrence-windows\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'recurrence-windows';
      parsedWindows = [];
      continue;
    }
    if (/^upstream-reporting\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'upstream-reporting';
      continue;
    }
    if (/^vendor-namespace\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'vendor-namespace';
      continue;
    }
    if (/^coverage-gap\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'coverage-gap';
      continue;
    }
    if (/^determinism-detection\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'determinism-detection';
      continue;
    }
    if (/^operator-time-cost\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = 'operator-time-cost';
      continue;
    }
    if (/^customSubclasses\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      block = 'customSubclasses';
      parsedSubclasses = [];
      continue;
    }
    // Reset on the top-level `quality:` wrapper — non-list, non-recognised key
    if (/^quality\s*:\s*$/.test(trimmed)) {
      if (block === 'recurrence-windows') flushWindows();
      if (block === 'customSubclasses') flushSubclasses();
      block = null;
      continue;
    }

    // ── Block body parsing ────────────────────────────────────────────
    if (block === 'recurrence-windows') {
      const listMatch = /^-\s*(.+)$/.exec(trimmed);
      if (listMatch && listMatch[1]) {
        const val = unquote(listMatch[1]);
        if (/^\d+d$/i.test(val)) parsedWindows.push(val.toLowerCase());
        continue;
      }
      // Non-list line: exit the block
      flushWindows();
      block = null;
      // fall through so the line can be re-tested as a header
    }

    if (block === 'customSubclasses') {
      const listMatch = /^-\s*(.+)$/.exec(trimmed);
      if (listMatch && listMatch[1]) {
        const val = unquote(listMatch[1]);
        if (val) parsedSubclasses.push(val);
        continue;
      }
      flushSubclasses();
      block = null;
    }

    if (block === 'upstream-reporting') {
      const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
      if (kvMatch && kvMatch[1] && kvMatch[2]) {
        const key = kvMatch[1];
        const val = unquote(kvMatch[2]);
        if (key === 'repoUrl') out.upstreamReporting.repoUrl = val;
        else if (key === 'prefilledIssueTemplate')
          out.upstreamReporting.prefilledIssueTemplate = val;
        continue;
      }
      // Non-kv line: exit
      block = null;
    }

    if (block === 'vendor-namespace') {
      const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
      if (kvMatch && kvMatch[1] && kvMatch[2]) {
        const key = kvMatch[1];
        const val = unquote(kvMatch[2]);
        if (key === 'enforce') {
          const lower = val.toLowerCase();
          if (lower === 'reject' || lower === 'warn' || lower === 'none') {
            out.vendorNamespace.enforce = lower;
          }
        }
        continue;
      }
      block = null;
    }

    if (block === 'coverage-gap') {
      const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
      if (kvMatch && kvMatch[1] && kvMatch[2]) {
        const key = kvMatch[1];
        const val = unquote(kvMatch[2]);
        const b = parseBool(val);
        if (b !== null) {
          if (key === 'autoQuarantine') out.coverageGap.autoQuarantine = b;
          else if (key === 'fileCapture') out.coverageGap.fileCapture = b;
        }
        continue;
      }
      block = null;
    }

    if (block === 'determinism-detection') {
      const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
      if (kvMatch && kvMatch[1] && kvMatch[2]) {
        const key = kvMatch[1];
        const val = unquote(kvMatch[2]);
        if (key === 'defaultSampleRate') {
          const parsed = Number(val);
          // Accept only finite rates in [0, 1]. Reject NaN / out-of-range
          // silently to avoid surprising the operator with a 200% sample rate.
          if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
            out.determinismDetection.defaultSampleRate = parsed;
          }
        } else {
          const b = parseBool(val);
          if (b !== null) {
            if (key === 'alwaysOnRequiresDeterminism')
              out.determinismDetection.alwaysOnRequiresDeterminism = b;
            else if (key === 'alwaysOnTopBlastRadiusDecile')
              out.determinismDetection.alwaysOnTopBlastRadiusDecile = b;
          }
        }
        continue;
      }
      block = null;
    }

    if (block === 'operator-time-cost') {
      const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+)$/.exec(trimmed);
      if (kvMatch && kvMatch[1] && kvMatch[2]) {
        const key = kvMatch[1];
        const val = unquote(kvMatch[2]);
        if (key === 'afkInactivityMinutes') {
          const parsed = Number(val);
          // Accept only non-negative finite minutes.
          if (Number.isFinite(parsed) && parsed >= 0) {
            out.operatorTimeCost.afkInactivityMinutes = parsed;
          }
        }
        continue;
      }
      block = null;
    }
  }

  // Flush any in-flight list-block
  if (block === 'recurrence-windows') flushWindows();
  if (block === 'customSubclasses') flushSubclasses();

  return out;
}

// ── Vendor-namespace enforcement (OQ-10) ─────────────────────────────

export interface ValidateOpts {
  /** Logger for `enforce: warn` mode. Defaults to `console`. */
  logger?: { warn: (msg: string) => void };
}

/**
 * Apply the OQ-10 vendor-namespace rule to a config's `customSubclasses`
 * list according to `vendorNamespace.enforce`. Mutates nothing; throws
 * `QualityMonitoringConfigError` on `reject` mode when a violation is
 * found. On `warn` mode, logs to the provided logger; on `none` mode,
 * skips the check entirely.
 *
 * Exported for unit tests + direct adopter use (e.g. validating a config
 * snippet before writing to disk).
 */
export function enforceVendorNamespaceConfig(
  config: QualityMonitoringConfig,
  opts: ValidateOpts = {},
): void {
  const mode = config.vendorNamespace.enforce;
  if (mode === 'none') return;
  if (!config.customSubclasses || config.customSubclasses.length === 0) return;

  const violations: { subclass: string; reason: string }[] = [];
  for (const subclass of config.customSubclasses) {
    const err = validateVendorNamespace(subclass);
    if (err) violations.push({ subclass, reason: err });
  }
  if (violations.length === 0) return;

  const lines = [
    `quality-monitoring.yaml — ${violations.length} customSubclass(es) violate the OQ-10 vendor-namespace rule:`,
    ...violations.map((v) => `  - '${v.subclass}': ${v.reason}`),
    '',
    'Fix: prefix custom subclasses with a vendor reverse-DNS namespace,',
    "e.g. 'acme-corp:custom-gate-faulty'.",
    '',
    'Background: RFC-0025 §10 + §13 OQ-10 (resolved 2026-05-15) — strict',
    'enforcement matches Kubernetes CRD, npm scoped, and Go module conventions.',
  ];
  const message = lines.join('\n');

  if (mode === 'warn') {
    const logger = opts.logger ?? { warn: (m: string): void => console.warn(m) };
    logger.warn(`[quality-monitoring] ${message}`);
    return;
  }
  // mode === 'reject' (default)
  throw new QualityMonitoringConfigError(message);
}

// ── Loader ────────────────────────────────────────────────────────────

export interface LoadQualityMonitoringConfigOpts {
  /** Project root. Config path = `<workDir>/.ai-sdlc/quality-monitoring.yaml`. */
  workDir?: string;
  /** Explicit config file path override (useful in tests). */
  filePath?: string;
  /** Logger forwarded to the OQ-10 enforcement step (only used in `warn` mode). */
  logger?: { warn: (msg: string) => void };
}

/**
 * Load the per-org quality monitoring config.
 *
 * Resolution order:
 * 1. `opts.filePath` (explicit override)
 * 2. `<opts.workDir>/.ai-sdlc/quality-monitoring.yaml`
 * 3. `<process.cwd()>/.ai-sdlc/quality-monitoring.yaml`
 *
 * Missing file → shipping defaults. Malformed file → shipping defaults
 * for the malformed sections (other sections still parse).
 *
 * Runs the OQ-10 vendor-namespace enforcement after parsing. Throws
 * `QualityMonitoringConfigError` when `vendorNamespace.enforce` is
 * `reject` (the default) and any declared custom subclass violates the
 * rule.
 */
export function loadQualityMonitoringConfig(
  opts: LoadQualityMonitoringConfigOpts = {},
): QualityMonitoringConfig {
  const filePath =
    opts.filePath ?? join(opts.workDir ?? process.cwd(), '.ai-sdlc', 'quality-monitoring.yaml');

  const fallback = (): QualityMonitoringConfig => ({
    recurrenceWindows: [...DEFAULT_RECURRENCE_WINDOWS],
    upstreamReporting: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.upstreamReporting },
    vendorNamespace: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.vendorNamespace },
    customSubclasses: [],
    coverageGap: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.coverageGap },
    determinismDetection: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.determinismDetection },
    operatorTimeCost: { ...QUALITY_MONITORING_CONFIG_DEFAULTS.operatorTimeCost },
  });

  if (!existsSync(filePath)) return fallback();

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return fallback();
  }

  const cfg = parseQualityMonitoringConfigYaml(raw);
  enforceVendorNamespaceConfig(cfg, { logger: opts.logger });
  return cfg;
}
