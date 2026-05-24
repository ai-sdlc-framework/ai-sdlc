/**
 * HC_cost channel — RFC-0009 §7.4 soft cost-pressure lever (AISDLC-318).
 *
 * Implements the operator-tunable HC_cost multiplier that shapes admission
 * priority for cost-sensitive tasks without refusing them (that is Eρ₆'s
 * job). The channel composes with the admission composite: cost-sensitive
 * tasks (those carrying `Stage.maxBudgetUsd`) have their HC priority
 * contribution scaled by `HC_cost ∈ [0.0, 1.0]`.
 *
 * ## Activation
 *
 * Gated on the adopter opt-in flag `AI_SDLC_HC_COST_ENABLED` (default off).
 * When off, `applyHcCost()` returns the original priority unchanged and no
 * `OrchestratorCostPolicyApplied` event is emitted. This lets operators
 * inspect the channel without activating it.
 *
 * ## Configuration
 *
 * Weight is read in this priority order:
 *   1. `AI_SDLC_HC_COST` env var (float string, e.g. `"0.5"`)
 *   2. `.ai-sdlc/calibration.yaml` → `hcCost.weight` (number in [0,1])
 *   3. Default 1.0 (neutral; no cost-based de-prioritization)
 *
 * ## What counts as a cost-sensitive task?
 *
 * Tasks carrying a `maxBudgetUsd` field in their frontmatter (mirrors
 * `Stage.maxBudgetUsd` from RFC-0010 §11.4). The `isCostSensitive()`
 * helper checks for this field — see callers in `loop.ts`.
 *
 * ## RFC-0016 calibration tier
 *
 * The data quality behind the lever grows with RFC-0016 calibration:
 *
 *   - **crude** — no calibration data yet (RFC-0016 ≤ P0 shipped); HC_cost
 *     only fires when the task explicitly carries `maxBudgetUsd`.
 *   - **moderate** — RFC-0016 Phase 1+ shipped (Stage A signals available);
 *     class-default cost estimates differentiate work classes.
 *   - **high** — RFC-0016 Phase 3+ shipped (calibration log flowing, per-class
 *     bias multipliers active); accurate per-task cost predictions.
 *
 * `readCalibrationTier()` inspects the `_estimates/` substrate on disk and
 * returns the current tier. The tier is surfaced in cli-admission output so
 * operators know the confidence level of the cost signals.
 *
 * ## Orchestrator event
 *
 * `OrchestratorCostPolicyApplied` is emitted to `events.jsonl` whenever
 * `HC_cost ≠ 1.0` is in effect and at least one cost-sensitive task was
 * evaluated in the tick. Per RFC-0009 §7.4 observability spec.
 *
 * @module orchestrator/hc-cost
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

// ── Constants ─────────────────────────────────────────────────────────

/** Default HC_cost weight (neutral — no cost-based de-prioritization). */
export const HC_COST_DEFAULT_WEIGHT = 1.0;

/** Env var for the opt-in gate. Default off. */
export const HC_COST_ENABLED_ENV = 'AI_SDLC_HC_COST_ENABLED';

/** Env var for the weight override. */
export const HC_COST_WEIGHT_ENV = 'AI_SDLC_HC_COST';

/** Minimum permitted weight value (inclusive). */
export const HC_COST_WEIGHT_MIN = 0.0;

/** Maximum permitted weight value (inclusive). */
export const HC_COST_WEIGHT_MAX = 1.0;

// ── Calibration tier ─────────────────────────────────────────────────

/**
 * RFC-0016 calibration data quality tier, per the §7.4 dependency table.
 *
 *  - `crude`    — no calibration data yet (RFC-0016 ≤ P0). HC_cost fires
 *                 on `maxBudgetUsd` presence only; no graduated cost signal.
 *  - `moderate` — RFC-0016 Phase 1+ shipped (Stage A log.jsonl exists with
 *                 ≥ 1 record). Class-default cost estimates available.
 *  - `high`     — RFC-0016 Phase 3+ shipped (calibration-YYYY-MM.jsonl files
 *                 exist). Accurate per-task cost predictions active.
 */
export type HcCostCalibrationTier = 'crude' | 'moderate' | 'high';

// ── Config loader ─────────────────────────────────────────────────────

/** Resolved HC_cost configuration for one tick. */
export interface HcCostConfig {
  /**
   * Whether the HC_cost channel is active (adopter opt-in gate).
   * When false, `applyHcCost()` is a no-op.
   */
  enabled: boolean;
  /**
   * Operator-tunable weight ∈ [0.0, 1.0].
   * Default 1.0 = neutral; lower values defer expensive work.
   */
  weight: number;
  /**
   * RFC-0016 calibration data quality tier. Surfaced in cli-admission
   * output so operators know how accurate the cost signals are.
   */
  calibrationTier: HcCostCalibrationTier;
}

/** Raw shape from `calibration.yaml`. Only the `hcCost` block is consumed. */
interface RawCalibrationYaml {
  hcCost?: {
    weight?: number;
  };
}

/**
 * Read HC_cost configuration from env + `.ai-sdlc/calibration.yaml` + defaults.
 *
 * Pure: this function reads env + disk but performs no side effects.
 *
 * @param workDir - project root (default `process.cwd()`)
 * @param artifactsDir - override for `$ARTIFACTS_DIR` (used in tests)
 * @param env - environment variable overrides (default `process.env`)
 */
export function loadHcCostConfig(opts: {
  workDir?: string;
  artifactsDir?: string;
  env?: Record<string, string | undefined>;
}): HcCostConfig {
  const env = opts.env ?? process.env;
  const workDir = opts.workDir ?? process.cwd();

  // ── Opt-in gate ───────────────────────────────────────────────────
  const rawEnabled = env[HC_COST_ENABLED_ENV];
  const enabled = parseEnabled(rawEnabled);

  // ── Weight resolution ─────────────────────────────────────────────
  // 1. AI_SDLC_HC_COST env var
  // 2. .ai-sdlc/calibration.yaml → hcCost.weight
  // 3. Default 1.0
  let weight = HC_COST_DEFAULT_WEIGHT;

  // Try env first.
  const rawEnvWeight = env[HC_COST_WEIGHT_ENV];
  if (rawEnvWeight !== undefined && rawEnvWeight !== '') {
    const parsed = parseFloat(rawEnvWeight);
    if (!isNaN(parsed)) {
      weight = clampWeight(parsed);
    }
  } else {
    // Try calibration.yaml.
    const yamlWeight = readCalibrationYamlWeight(workDir);
    if (yamlWeight !== null) {
      weight = clampWeight(yamlWeight);
    }
  }

  // ── Calibration tier ──────────────────────────────────────────────
  const calibrationTier = readCalibrationTier(opts.artifactsDir);

  return { enabled, weight, calibrationTier };
}

// ── Core application ──────────────────────────────────────────────────

/** Result of applying HC_cost to a single candidate. */
export interface HcCostApplication {
  /** Original numeric priority (before HC_cost). */
  originalPriority: number;
  /** Adjusted numeric priority (after HC_cost). Equal to `originalPriority` when not cost-sensitive or weight=1.0. */
  adjustedPriority: number;
  /** Whether the candidate was cost-sensitive (`maxBudgetUsd` present). */
  isCostSensitive: boolean;
  /** Priority delta induced by HC_cost (negative = de-prioritized). */
  priorityDelta: number;
}

/**
 * Apply the HC_cost multiplier to a candidate's priority.
 *
 * Per RFC-0009 §7.4:
 *   HC_total(w) ← HC_total(w) × HC_cost^isCostSensitive(w)
 *
 * When `config.enabled === false` OR `taskMaxBudgetUsd === undefined` OR
 * `config.weight === 1.0`, returns the original priority unchanged.
 *
 * @param priority         numeric priority of the candidate (from effectivePriority)
 * @param taskMaxBudgetUsd the `maxBudgetUsd` field from the task's frontmatter
 *                         (undefined when absent — task is NOT cost-sensitive)
 * @param config           resolved HC_cost configuration for this tick
 */
export function applyHcCost(
  priority: number,
  taskMaxBudgetUsd: number | undefined,
  config: HcCostConfig,
): HcCostApplication {
  const isCostSensitive = taskMaxBudgetUsd !== undefined;

  // No-op when:
  //   - channel is disabled (opt-in gate)
  //   - task is not cost-sensitive (no maxBudgetUsd)
  //   - weight is exactly neutral (1.0 → no change)
  if (!config.enabled || !isCostSensitive || config.weight === HC_COST_DEFAULT_WEIGHT) {
    return {
      originalPriority: priority,
      adjustedPriority: priority,
      isCostSensitive,
      priorityDelta: 0,
    };
  }

  const adjustedPriority = priority * config.weight;
  return {
    originalPriority: priority,
    adjustedPriority,
    isCostSensitive,
    priorityDelta: adjustedPriority - priority,
  };
}

// ── cli-admission output ──────────────────────────────────────────────

/**
 * Format a single-line cli-admission status string for the HC_cost channel.
 *
 * Surfaced in `[orchestrator] hc-cost:` log lines so operators can see:
 *   - whether the channel is active
 *   - current weight setting
 *   - RFC-0016 calibration tier (so they know cost-signal accuracy)
 *
 * @param config resolved HC_cost config
 * @param affectedCount number of cost-sensitive tasks evaluated this tick
 */
export function formatHcCostAdmissionLine(config: HcCostConfig, affectedCount: number): string {
  if (!config.enabled) {
    return `[orchestrator] hc-cost: disabled (opt-in via AI_SDLC_HC_COST_ENABLED=1)`;
  }
  if (config.weight === HC_COST_DEFAULT_WEIGHT) {
    return `[orchestrator] hc-cost: enabled, weight=1.0 (neutral; no cost de-prioritization), calibration=${config.calibrationTier}`;
  }
  return (
    `[orchestrator] hc-cost: enabled, weight=${config.weight}, ` +
    `calibration=${config.calibrationTier}, cost-sensitive-tasks-affected=${affectedCount}`
  );
}

// ── RFC-0016 calibration tier detection ──────────────────────────────

/**
 * Inspect the `_estimates/` substrate on disk and return the RFC-0016
 * calibration tier per the §7.4 dependency table.
 *
 * Tier detection logic (in priority order):
 *
 *  1. `high`     — `_estimates/calibration-YYYY-MM.jsonl` file(s) exist AND
 *                  at least one has ≥ 1 line (Phase 3 shipped).
 *  2. `moderate` — `_estimates/log.jsonl` exists AND has ≥ 1 line
 *                  (Phase 1/2 shipped).
 *  3. `crude`    — fallback (no calibration substrate present yet).
 *
 * Degrade-open on disk errors: if the directory can't be read, falls back
 * to `crude` so the channel doesn't crash the orchestrator.
 *
 * @param artifactsDir override for `$ARTIFACTS_DIR`
 */
export function readCalibrationTier(artifactsDir?: string): HcCostCalibrationTier {
  const resolvedArtifacts = artifactsDir ?? process.env['ARTIFACTS_DIR'] ?? '.artifacts';
  const estimatesDir = join(resolvedArtifacts, '_estimates');

  try {
    // Phase 3 check: monthly calibration JSONL files.
    if (existsSync(estimatesDir)) {
      const entries = readdirSync(estimatesDir);
      const calibrationFiles = entries.filter(
        (f) => f.startsWith('calibration-') && f.endsWith('.jsonl'),
      );
      for (const file of calibrationFiles) {
        const content = readFileSync(join(estimatesDir, file), 'utf8').trim();
        if (content.length > 0) {
          return 'high';
        }
      }

      // Phase 1/2 check: estimate log.jsonl.
      const logPath = join(estimatesDir, 'log.jsonl');
      if (existsSync(logPath)) {
        const logContent = readFileSync(logPath, 'utf8').trim();
        if (logContent.length > 0) {
          return 'moderate';
        }
      }
    }
  } catch {
    // Degrade-open: disk errors → crude.
  }

  return 'crude';
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse the opt-in env var value to a boolean.
 *
 * Truthy: `"1"`, `"true"`, `"yes"`, `"on"` (case-insensitive).
 * Everything else (including absent/undefined) is falsy → channel off.
 */
function parseEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** Clamp a weight value into [HC_COST_WEIGHT_MIN, HC_COST_WEIGHT_MAX]. */
function clampWeight(raw: number): number {
  return Math.max(HC_COST_WEIGHT_MIN, Math.min(HC_COST_WEIGHT_MAX, raw));
}

/**
 * Read `hcCost.weight` from `.ai-sdlc/calibration.yaml` if it exists.
 * Returns `null` when the file is absent, malformed, or the field is missing.
 *
 * Degrade-open: any parse error → null (fall through to default).
 */
function readCalibrationYamlWeight(workDir: string): number | null {
  const yamlPath = join(workDir, '.ai-sdlc', 'calibration.yaml');
  if (!existsSync(yamlPath)) return null;

  try {
    const raw = readFileSync(yamlPath, 'utf8');
    const parsed = parseYaml(raw) as RawCalibrationYaml | null;
    if (!parsed || typeof parsed !== 'object') return null;

    const weight = parsed.hcCost?.weight;
    if (typeof weight !== 'number' || isNaN(weight)) return null;

    return weight;
  } catch {
    // Malformed YAML or read error → fall through.
    return null;
  }
}

// ── Task cost-sensitivity detector ───────────────────────────────────

/**
 * Read the `maxBudgetUsd` field from a task's frontmatter.
 *
 * Returns the numeric value when present, or `undefined` when the task
 * does not declare a budget cap (not cost-sensitive per RFC-0009 §7.4).
 *
 * This is a pure extraction from the pre-parsed YAML map — no disk I/O.
 * Callers (loop.ts) parse the full frontmatter once and pass the value here.
 */
export function extractMaxBudgetUsd(
  frontmatter: Record<string, unknown> | undefined,
): number | undefined {
  if (!frontmatter) return undefined;
  const raw = frontmatter['maxBudgetUsd'];
  if (typeof raw === 'number' && isFinite(raw) && raw > 0) return raw;
  return undefined;
}
