/**
 * RFC-0025 §5 failure-mode classifier — Phase 2 confidence-bucketed
 * classifier (AISDLC-303 / OQ-1).
 *
 * `classifyFailure()` takes a failure signal from a playbook handler
 * (or any pipeline checkpoint) and returns one of the four §5 taxonomy
 * classes plus a `confidence` + `bucket` per the OQ-1 three-tier model:
 *
 *   - `operator-under-decided`    — issue genuinely lacked a decision
 *   - `framework-misbehaved`      — framework violated its own contract
 *   - `ambiguous`                 — can't tell without operator triage
 *   - `external-dependency-failed`— outside the framework's control
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 2 — OQ-1 confidence-bucketed three-tier classifier (AISDLC-303)
 * ─────────────────────────────────────────────────────────────────────
 * Each invocation produces a numeric `confidence` in [0, 1] from a
 * weighted-heuristic scorer (see `scoreSignal()`). The configured
 * thresholds (per-org via `.ai-sdlc/quality-monitoring.yaml` —
 * `quality.classifier.confidenceThresholds`) bucket the result:
 *
 *   - confidence ≥ `autoClassify` (default 0.7) →
 *       bucket: `'auto-classify'` — class is one of the four taxonomy
 *       classes; framework-misbehaved emits a capture record per §6.
 *   - `ambiguous` ≤ confidence < `autoClassify` (default 0.3..0.7) →
 *       bucket: `'ambiguous'` — class is `'ambiguous'`; operator triages
 *       via the standard RFC-0024 rubric.
 *   - confidence < `ambiguous` (default 0.3) →
 *       bucket: `'unclassified'` — class is `'ambiguous'`; NO capture
 *       record is produced (the substrate logs the input + scoring
 *       breakdown so the corpus aggregator can post-mortem patterns the
 *       heuristics consistently miss, but the operator is NOT paged).
 *
 * The calibration loop (`classification-calibration.ts`) composes with
 * the AISDLC-321 substrate's polarity model:
 *   - Operator overrides an auto-classify result within the override
 *     window → negative exemplar.
 *   - Silence within the window → positive exemplar.
 * Per the task brief: "uses the shared classifier substrate from
 * AISDLC-321 (no new classifier infrastructure)." We reuse the
 * substrate's `appendCorpusEntry()` / `setCorpusEntryPolarity()` / the
 * `pending → positive | negative` polarity vocabulary; the only thing
 * that's new here is the per-org thresholds + the bucket field.
 *
 * Subclasses for `framework-misbehaved` map directly to the §5.2 table:
 *   - `framework-determinism-violated`
 *   - `framework-gate-faulty`
 *   - `framework-silent-failure`
 *   - `framework-contract-violated`
 *   - `framework-sweep-incomplete`
 *   - `framework-coverage-gap`
 *   - `framework-perf-regression`
 *
 * Vendor-namespaced adopter subclasses (per §10 / OQ-10) are also
 * supported — they MUST carry a `<vendor>:` prefix. The classifier
 * validates custom subclass names on input; un-namespaced custom
 * subclasses are rejected with a `ClassificationError`.
 *
 * Integration:
 *   - Playbook handlers (`pipeline-cli/src/orchestrator/playbook/handlers`)
 *     compose with this by calling `classifyFailure(error, context)`.
 *   - `framework-misbehaved` results carry a `captureRecord` shaped per
 *     RFC-0024 so the auto-router can append directly.
 *   - Severity is computed inline per §7 composite rubric.
 */

import type { FailureSignal } from '../../orchestrator/playbook/types.js';
import {
  resolveClassifierConfidenceThresholds,
  type ClassifierConfidenceConfig,
  type SeverityWeightsConfig,
} from './quality-monitoring-config.js';

export type { FailureSignal };

// ── §13.1 OQ-1 shipping defaults (inlined to avoid circular import) ──
//
// `quality-monitoring-config.ts` also imports `validateVendorNamespace`
// from this file for OQ-10 enforcement, so importing
// QUALITY_MONITORING_CONFIG_DEFAULTS from there creates a circular
// dependency that resolves to `undefined` at module-init time. We
// duplicate the defaults here (kept in sync by tests) to break the
// cycle without adding an indirection layer.

const _DEFAULT_AUTO_CLASSIFY_THRESHOLD = 0.7;
const _DEFAULT_AMBIGUOUS_THRESHOLD = 0.3;

// ── §5 Taxonomy ───────────────────────────────────────────────────────

export type FailureClass =
  | 'operator-under-decided'
  | 'framework-misbehaved'
  | 'ambiguous'
  | 'external-dependency-failed';

/**
 * Built-in `framework-misbehaved` subclasses per RFC-0025 §5.2.
 * Adopter-defined subclasses must be vendor-namespaced
 * (e.g. `acme-corp:custom-gate-faulty`) — see OQ-10.
 */
export type FrameworkSubclass =
  | 'framework-determinism-violated'
  | 'framework-gate-faulty'
  | 'framework-silent-failure'
  | 'framework-contract-violated'
  | 'framework-sweep-incomplete'
  | 'framework-coverage-gap'
  | 'framework-perf-regression'
  | string; // vendor-namespaced custom subclass

export const BUILTIN_FRAMEWORK_SUBCLASSES: ReadonlySet<string> = new Set([
  'framework-determinism-violated',
  'framework-gate-faulty',
  'framework-silent-failure',
  'framework-contract-violated',
  'framework-sweep-incomplete',
  'framework-coverage-gap',
  'framework-perf-regression',
]);

// ── §7 Severity rubric ─────────────────────────────────────────────────

/** §7.1 Operator-time-cost axis. */
export type OperatorTimeCost = 'high' | 'medium' | 'low';

/** §7.2 Blast-radius axis. */
export type BlastRadius = 'high' | 'medium' | 'low';

/** §7.3 Frequency axis. */
export type Frequency = 'high' | 'medium' | 'low';

export type CompositeSeverity = 'high' | 'medium' | 'low';

export interface SeverityAxes {
  operatorTimeCost: OperatorTimeCost;
  blastRadius: BlastRadius;
  frequency: Frequency;
}

export interface SeverityScore {
  composite: CompositeSeverity;
  axes: SeverityAxes;
}

/**
 * §7 composite severity rubric.
 *
 * Unweighted (default — backward-compatible with pre-AISDLC-305 callers):
 *   composite = max(operatorTimeCost, blastRadius) raised one level if
 *   frequency is `high`.
 *
 * Weighted (OQ-2 / AISDLC-305): when `weights` is supplied, each
 * qualitative axis ordinal (`low=0`, `medium=1`, `high=2`) is multiplied
 * by the per-axis weight before taking the max + frequency bump. The
 * resulting weighted score is re-bucketed back into `low`/`medium`/`high`
 * using `<1 → low`, `<2 → medium`, `≥2 → high`. The frequency bump is
 * preserved (a `high`-frequency axis with positive weight still raises
 * the composite by one bucket, ceiling at `high`).
 *
 * Backward compatibility: callers that omit `weights` get exact pre-OQ-2
 * behavior; the existing test suite covers both branches.
 */
export function computeSeverity(
  axes: SeverityAxes,
  weights?: SeverityWeightsConfig,
): SeverityScore {
  const ORDER: Record<CompositeSeverity, number> = { low: 0, medium: 1, high: 2 };
  const FROM_ORDER: CompositeSeverity[] = ['low', 'medium', 'high'];

  if (!weights) {
    const base = Math.max(ORDER[axes.operatorTimeCost], ORDER[axes.blastRadius]);
    const raised = axes.frequency === 'high' ? Math.min(base + 1, 2) : base;
    const composite = FROM_ORDER[raised] ?? 'low';
    return { composite, axes };
  }

  // OQ-2 weighted path. Weights are guaranteed ≥ 0 by the config parser
  // and `parseSeverityWeightFlag()`; defensive Math.max(0, ...) shields
  // any caller that bypassed both.
  const wOtc = Math.max(0, weights.operatorTimeCost);
  const wBlast = Math.max(0, weights.blastRadius);
  const wFreq = Math.max(0, weights.frameworkRecurrence);

  const weightedOtc = ORDER[axes.operatorTimeCost] * wOtc;
  const weightedBlast = ORDER[axes.blastRadius] * wBlast;
  let weighted = Math.max(weightedOtc, weightedBlast);
  if (axes.frequency === 'high' && wFreq > 0) {
    weighted += 1; // §7 frequency bump — proportional to its presence, not its weight
  }

  // Re-bucket: <1 → low, <2 → medium, ≥2 → high. Matches the unweighted
  // ORDER table boundaries so default-weights = 1.0 produces identical
  // bucket assignments to the unweighted path.
  let bucketIndex: number;
  if (weighted < 1) bucketIndex = 0;
  else if (weighted < 2) bucketIndex = 1;
  else bucketIndex = 2;
  const composite = FROM_ORDER[bucketIndex] ?? 'low';
  return { composite, axes };
}

// ── Capture record shape (RFC-0024 subset) ────────────────────────────

/**
 * RFC-0024 capture record produced for `framework-misbehaved` failures.
 * Auto-router uses this shape to append to the backlog with
 * `triage: framework-bug`.
 */
export interface FrameworkBugCaptureRecord {
  ts: string;
  class: 'framework-misbehaved';
  subclass: FrameworkSubclass;
  severity: SeverityScore;
  triage: 'framework-bug';
  taskId?: string;
  workerId?: string;
  source?: string;
  auditTrail: {
    classificationResult: ClassificationResult;
    originalFailure: {
      stderr: string;
      exitCode: number | null;
      source?: string;
    };
  };
}

// ── Classification context and result ─────────────────────────────────

/**
 * The OQ-1 confidence bucket for a classification result.
 *
 * - `'auto-classify'` — confidence ≥ `autoClassify` threshold (default 0.7).
 *   The classifier's chosen class stands on its own; the framework auto-
 *   routes (capture record + optional backlog write).
 * - `'ambiguous'` — `ambiguous` ≤ confidence < `autoClassify` (default
 *   0.3..0.7). The class is `'ambiguous'`; the operator triages via the
 *   standard RFC-0024 rubric.
 * - `'unclassified'` — confidence < `ambiguous` threshold (default 0.3).
 *   The class is `'ambiguous'` but NO capture record is produced and no
 *   operator-facing surface fires. The substrate logs the signal +
 *   scoring breakdown so the corpus aggregator can post-mortem patterns
 *   the heuristics consistently miss.
 */
export type ConfidenceBucket = 'auto-classify' | 'ambiguous' | 'unclassified';

/**
 * Context for classification. The classifier uses available signals from
 * the failure context plus heuristics to determine the failure class.
 */
export interface ClassificationContext {
  taskId?: string;
  workerId?: string;
  /** Wall-clock at which the failure was captured. Defaults to `new Date()`. */
  ts?: Date;
  /**
   * Optional hint from the caller about the likely subclass. When provided,
   * the classifier treats it as a strong signal (but may override when
   * evidence contradicts it).
   */
  subclassHint?: FrameworkSubclass;
  /**
   * Optional severity axes override. When provided, overrides the
   * auto-inferred axes. Useful for playbook handlers that have richer
   * context than the failure signal alone.
   */
  severityAxes?: Partial<SeverityAxes>;
  /**
   * Optional explicit confidence-threshold override for THIS call. When
   * provided, takes precedence over the per-org `quality-monitoring.yaml`
   * resolution. Useful for tests + for callers that want a stricter or
   * more lenient bucket boundary than the org default (e.g. a security-
   * sensitive pipeline that wants `autoClassify: 0.85`).
   *
   * Defaults are applied per-field when only one of `{autoClassify,
   * ambiguous}` is supplied: the omitted field falls through to the
   * per-org config / shipping default.
   */
  thresholds?: Partial<ClassifierConfidenceConfig>;
  /**
   * Optional project root used to locate `.ai-sdlc/quality-monitoring.yaml`
   * for the per-org threshold resolution. Defaults to `process.cwd()`.
   */
  workDir?: string;
  /**
   * Optional precomputed thresholds. When supplied, bypasses the
   * per-org config lookup entirely (useful in hot loops where the same
   * thresholds are reused across many classifications — the caller
   * resolves once and threads through). Takes precedence over
   * `thresholds` + `workDir`.
   */
  resolvedThresholds?: ClassifierConfidenceConfig;
  /**
   * Optional best-effort logger for unclassified-tier signals. The Phase 2
   * brief specifies "low-confidence cases (< 0.3) log only — no operator-
   * facing artifact". When supplied, the classifier writes a one-line
   * breakdown via `logger.info()` so the operator can post-mortem patterns
   * the heuristic missed without surfacing them in the TUI.
   */
  logger?: { info?: (msg: string) => void };
}

export interface ClassificationResult {
  class: FailureClass;
  /** Populated only when `class === 'framework-misbehaved'`. */
  subclass?: FrameworkSubclass;
  severity: SeverityScore;
  /**
   * RFC-0024 capture record for `framework-misbehaved` results in the
   * `'auto-classify'` bucket. `null` for other classes / buckets — no
   * auto-routing needed.
   *
   * The `'ambiguous'` bucket and the `'unclassified'` bucket both leave
   * this null: ambiguous cases route through the operator-triage UX (no
   * auto-write to backlog), and unclassified cases produce no operator
   * surface at all.
   */
  captureRecord: FrameworkBugCaptureRecord | null;
  /** Human-readable rationale for the classification. */
  rationale: string;
  /**
   * The OQ-1 confidence-bucketed score in [0, 1]. Computed by the
   * heuristic scorer from pattern matches + caller hints. The substrate
   * uses this to assign `bucket` per the resolved thresholds.
   */
  confidence: number;
  /**
   * The bucket the confidence landed in per the resolved thresholds. See
   * `ConfidenceBucket` for the full semantics.
   */
  bucket: ConfidenceBucket;
  /**
   * The effective thresholds applied to this classification. Surfaced so
   * audit logs + the calibration corpus can record what bucket boundaries
   * produced the result (operators tuning thresholds need this).
   */
  effectiveThresholds: ClassifierConfidenceConfig;
}

// ── External-dependency signal patterns ──────────────────────────────

/** Patterns that indicate an external dependency failed (not a framework bug). */
const EXTERNAL_DEPENDENCY_PATTERNS: RegExp[] = [
  /github\s+api\s+(error|outage|unavailable)/i,
  /anthropic\s+(api|claude)\s+(error|rate.?limit|overloaded)/i,
  /rate.?limit(ed)?/i,
  /npm\s+(registry|ERR)/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i,
  /network\s+(error|partition|timeout)/i,
  /503\s+service\s+unavailable/i,
  /502\s+bad\s+gateway/i,
];

/** Patterns that indicate a framework contract violation. */
const CONTRACT_VIOLATION_PATTERNS: RegExp[] = [
  /developer.*returned.*prose/i,
  /JSON\s+envelope\s+required/i,
  /parse.*developer.*return/i,
  /invalid.*json.*response/i,
  /SyntaxError.*JSON/i,
];

/** Patterns that indicate a framework sweep / cleanup failure. */
const SWEEP_INCOMPLETE_PATTERNS: RegExp[] = [
  /worktree.*left.*after\s+fail/i,
  /sentinel.*not.*removed/i,
  /cleanup.*fail/i,
  /active.task.*stale/i,
];

/** Patterns that indicate a silent framework failure. */
const SILENT_FAILURE_PATTERNS: RegExp[] = [
  /filter.*throw/i,
  /pre.dispatch.*fail/i,
  /swallowed.*error/i,
  /silently.*dispatch/i,
];

/** Patterns that indicate a performance regression. */
const PERF_REGRESSION_PATTERNS: RegExp[] = [
  /3x\s+baseline/i,
  /took\s+dramatically\s+longer/i,
  /performance\s+regression/i,
  /timeout.*baseline/i,
];

/** Patterns for operator-under-decided failures (DoR gaps). */
const OPERATOR_UNDER_DECIDED_PATTERNS: RegExp[] = [
  /AC\s+list\s+missing/i,
  /open\s+question.*unanswered/i,
  /needs.clarification/i,
  /missing\s+acceptance\s+criteria/i,
  /DoR.*failed/i,
  /definition.of.ready.*fail/i,
];

// ── Vendor-namespace validation (OQ-10) ──────────────────────────────

/**
 * Validates a custom adopter subclass name (OQ-10 / §10).
 * Returns `null` if valid, or an error message if invalid.
 *
 * Rules:
 * - Must be `<vendor-prefix>:<subclass>` (one colon, non-empty on both sides)
 * - Vendor prefix must be lower-kebab-case: `[a-z][a-z0-9-]*`
 * - Subclass must be non-empty
 */
export function validateVendorNamespace(subclass: string): string | null {
  if (BUILTIN_FRAMEWORK_SUBCLASSES.has(subclass)) return null; // built-in, no prefix needed

  const colonIdx = subclass.indexOf(':');
  if (colonIdx < 1) {
    return (
      `custom subclass '${subclass}' must be vendor-namespaced (e.g. 'acme-corp:custom-gate-faulty') ` +
      `— un-namespaced custom subclasses are rejected per RFC-0025 §10 / OQ-10`
    );
  }
  const vendor = subclass.slice(0, colonIdx);
  const name = subclass.slice(colonIdx + 1);
  if (!/^[a-z][a-z0-9-]*$/.test(vendor)) {
    return (
      `vendor prefix '${vendor}' in custom subclass '${subclass}' must match [a-z][a-z0-9-]* ` +
      `(lower-kebab-case vendor name)`
    );
  }
  if (!name || name.length === 0) {
    return `custom subclass '${subclass}' must have a non-empty name after the vendor prefix`;
  }
  return null;
}

export class ClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassificationError';
  }
}

// ── Heuristic classification ──────────────────────────────────────────

/** Count how many patterns in a list match the text. */
function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const p of patterns) {
    if (p.test(text)) n++;
  }
  return n;
}

// ── OQ-1 confidence scoring ───────────────────────────────────────────

/**
 * Per-class confidence weights. Each weight expresses "how much one
 * matched pattern from this family raises confidence in this class". The
 * values are calibrated so:
 *   - A single match in a high-signal family (external-dependency / contract
 *     violation) lands in the `auto-classify` bucket (≥ 0.7).
 *   - A single match in a softer family (silent-failure / perf-regression /
 *     operator-under-decided / sweep-incomplete) lands in the `ambiguous`
 *     bucket (0.3–0.7).
 *   - Multiple matches stack to push above the auto-classify threshold.
 *   - Caller-supplied `subclassHint` is a strong signal — single hint
 *     alone pushes into the auto-classify bucket.
 *
 * The exact weights are tuned for the default 0.7 / 0.3 thresholds; per-
 * org threshold overrides shift the bucket boundaries but the relative
 * confidence ordering remains stable. Subsequent calibration-corpus
 * analysis will retune these as exemplars accumulate.
 */
const CONFIDENCE_WEIGHTS = Object.freeze({
  externalDependencyMatch: 0.75,
  contractViolationMatch: 0.75,
  sweepIncompleteMatch: 0.55,
  silentFailureMatch: 0.55,
  perfRegressionMatch: 0.5,
  operatorUnderDecidedMatch: 0.65,
  /** Additional confidence per additional matched pattern within the same family. */
  additionalMatchBonus: 0.1,
  /** Caller-supplied subclassHint is a strong human signal. */
  subclassHintBaseline: 0.8,
  /** Exit code non-zero + non-empty stderr — modest "this is real" signal. */
  realFailureSignal: 0.05,
  /** Empty stderr + null exit code — drag confidence down (heuristics had nothing to chew on). */
  noSignalPenalty: 0.4,
});

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Resolve the effective thresholds for THIS classification call. Precedence:
 *   1. `ctx.resolvedThresholds` (caller fully precomputed)
 *   2. `ctx.thresholds` (per-call partial override) + per-org / default fill-in
 *   3. per-org from `<ctx.workDir>/.ai-sdlc/quality-monitoring.yaml`
 *   4. shipping defaults (0.7 / 0.3)
 *
 * The function never throws — a malformed quality-monitoring.yaml falls
 * through to the shipping defaults so the classifier stays available
 * even when other config sections are broken.
 */
function resolveEffectiveThresholds(ctx: ClassificationContext): ClassifierConfidenceConfig {
  if (ctx.resolvedThresholds) {
    return normaliseThresholds(ctx.resolvedThresholds);
  }
  const fromConfig = resolveClassifierConfidenceThresholds({ workDir: ctx.workDir });
  const merged: ClassifierConfidenceConfig = {
    autoClassify: ctx.thresholds?.autoClassify ?? fromConfig.autoClassify,
    ambiguous: ctx.thresholds?.ambiguous ?? fromConfig.ambiguous,
  };
  return normaliseThresholds(merged);
}

/**
 * Defensively clamp thresholds to [0, 1] and ensure
 * `ambiguous <= autoClassify` so the bucket logic stays monotonic.
 * Mirrors the same swap-when-reversed behaviour the YAML parser applies,
 * so a caller passing per-call thresholds gets the same safety net.
 */
function normaliseThresholds(t: ClassifierConfidenceConfig): ClassifierConfidenceConfig {
  let autoClassify = clamp01(t.autoClassify);
  let ambiguous = clamp01(t.ambiguous);
  if (ambiguous > autoClassify) {
    const tmp = ambiguous;
    ambiguous = autoClassify;
    autoClassify = tmp;
  }
  return { autoClassify, ambiguous };
}

/**
 * Compute the OQ-1 bucket from a confidence + the resolved thresholds.
 * Boundary semantics: `autoClassify` is inclusive (`>=` → auto-classify);
 * `ambiguous` is inclusive (`>=` → ambiguous). Strictly below `ambiguous`
 * → unclassified.
 */
function bucketForConfidence(
  confidence: number,
  thresholds: ClassifierConfidenceConfig,
): ConfidenceBucket {
  if (confidence >= thresholds.autoClassify) return 'auto-classify';
  if (confidence >= thresholds.ambiguous) return 'ambiguous';
  return 'unclassified';
}

/**
 * Per-class scoring breakdown the heuristic produces. The class with the
 * highest score becomes the candidate; the score itself is the confidence.
 *
 * The scorer is intentionally simple — weighted pattern matching with a
 * stacking bonus for multiple matches in the same family. The calibration
 * corpus (`classification-calibration.ts`) feeds future retuning; we'll
 * graduate to a real Haiku-class invocation via the AISDLC-321 substrate
 * once the corpus has enough exemplars to validate the upgrade.
 */
interface ScoringBreakdown {
  externalDependency: number;
  operatorUnderDecided: number;
  contractViolation: number;
  sweepIncomplete: number;
  silentFailure: number;
  perfRegression: number;
}

function scoreSignal(stderr: string, exitCode: number | null): ScoringBreakdown {
  const family = (matches: number, baseWeight: number): number => {
    if (matches === 0) return 0;
    return clamp01(baseWeight + (matches - 1) * CONFIDENCE_WEIGHTS.additionalMatchBonus);
  };

  const realFailureBonus =
    exitCode !== null && exitCode !== 0 && stderr.length > 0
      ? CONFIDENCE_WEIGHTS.realFailureSignal
      : 0;

  const apply = (matches: number, weight: number): number =>
    matches === 0 ? 0 : clamp01(family(matches, weight) + realFailureBonus);

  return {
    externalDependency: apply(
      countMatches(stderr, EXTERNAL_DEPENDENCY_PATTERNS),
      CONFIDENCE_WEIGHTS.externalDependencyMatch,
    ),
    operatorUnderDecided: apply(
      countMatches(stderr, OPERATOR_UNDER_DECIDED_PATTERNS),
      CONFIDENCE_WEIGHTS.operatorUnderDecidedMatch,
    ),
    contractViolation: apply(
      countMatches(stderr, CONTRACT_VIOLATION_PATTERNS),
      CONFIDENCE_WEIGHTS.contractViolationMatch,
    ),
    sweepIncomplete: apply(
      countMatches(stderr, SWEEP_INCOMPLETE_PATTERNS),
      CONFIDENCE_WEIGHTS.sweepIncompleteMatch,
    ),
    silentFailure: apply(
      countMatches(stderr, SILENT_FAILURE_PATTERNS),
      CONFIDENCE_WEIGHTS.silentFailureMatch,
    ),
    perfRegression: apply(
      countMatches(stderr, PERF_REGRESSION_PATTERNS),
      CONFIDENCE_WEIGHTS.perfRegressionMatch,
    ),
  };
}

/**
 * Apply the "no signal" penalty. When the failure carries an empty stderr
 * AND no exit code, the heuristics have nothing to chew on; the
 * classifier shouldn't pretend it knows. We zero the breakdown and rely
 * on the per-family scores all being 0 → final confidence 0 → unclassified.
 *
 * The penalty matters mostly for the `subclassHint`-only path (see
 * classifyFailure), where the hint alone would otherwise push confidence
 * to 0.8 even on a no-signal failure. The penalty is subtracted from the
 * baseline hint to drop the result into the `ambiguous` bucket on
 * no-signal failures rather than auto-classifying them.
 */
function noSignal(stderr: string, exitCode: number | null): boolean {
  return stderr.trim().length === 0 && exitCode === null;
}

/**
 * Infer severity axes from failure signal heuristics.
 * Callers may override any axis via `ctx.severityAxes`.
 */
function inferSeverityAxes(signal: FailureSignal, subclass?: FrameworkSubclass): SeverityAxes {
  // operator-time-cost: high if operator must manually investigate + remediate
  // (contract violated, sweep incomplete, coverage-gap, gate-faulty all cost high)
  const HIGH_COST_SUBCLASSES = new Set([
    'framework-contract-violated',
    'framework-sweep-incomplete',
    'framework-coverage-gap',
    'framework-gate-faulty',
  ]);
  const operatorTimeCost: OperatorTimeCost =
    subclass && HIGH_COST_SUBCLASSES.has(subclass)
      ? 'high'
      : signal.exitCode !== null && signal.exitCode !== 0
        ? 'medium'
        : 'low';

  // blast-radius: high if exit code suggests a system-wide failure
  // (pre-dispatch filter, determinism-violated affects every dispatch)
  const HIGH_BLAST_SUBCLASSES = new Set([
    'framework-determinism-violated',
    'framework-gate-faulty',
    'framework-silent-failure',
  ]);
  const blastRadius: BlastRadius =
    subclass && HIGH_BLAST_SUBCLASSES.has(subclass) ? 'high' : 'medium';

  // frequency: always 'low' when inferred (the recurrence rate from
  // quality captures corpus is needed for accurate frequency — callers
  // with corpus access can override via ctx.severityAxes)
  const frequency: Frequency = 'low';

  return { operatorTimeCost, blastRadius, frequency };
}

/**
 * Classify a framework failure signal into one of the §5 taxonomy classes
 * using the OQ-1 confidence-bucketed three-tier model (AISDLC-303 /
 * Phase 2).
 *
 * The classifier:
 *   1. Resolves per-org thresholds from `.ai-sdlc/quality-monitoring.yaml`
 *      (default 0.7 / 0.3) — see `resolveEffectiveThresholds()`.
 *   2. Scores each candidate class via `scoreSignal()` (weighted pattern
 *      matching across stderr, plus subclass-hint baseline + no-signal
 *      penalty).
 *   3. Picks the highest-scoring class as the candidate; ties go to the
 *      precedence order: external-dependency > framework-misbehaved >
 *      operator-under-decided. This matches the §5 taxonomy's
 *      "external-dep takes precedence" intuition (you don't blame the
 *      framework for a GitHub outage).
 *   4. Buckets the confidence per OQ-1:
 *        - `'auto-classify'`  (≥ autoClassify) → emits the chosen class +
 *          a capture record for framework-misbehaved.
 *        - `'ambiguous'`      (≥ ambiguous, < autoClassify) → class is
 *          `'ambiguous'`, no capture record (operator triages).
 *        - `'unclassified'`   (< ambiguous) → class is `'ambiguous'`,
 *          no capture record, no operator-facing surface (log-only via
 *          `ctx.logger.info()`).
 *
 * @throws ClassificationError when `ctx.subclassHint` is a custom
 *   subclass that violates the vendor-namespace rule (§10 / OQ-10).
 */
export function classifyFailure(
  signal: FailureSignal,
  ctx: ClassificationContext = {},
): ClassificationResult {
  const ts = (ctx.ts ?? new Date()).toISOString();
  const stderr = signal.stderr ?? '';

  // Validate custom subclass hint (OQ-10)
  if (ctx.subclassHint) {
    const err = validateVendorNamespace(ctx.subclassHint);
    if (err) throw new ClassificationError(err);
  }

  const thresholds = resolveEffectiveThresholds(ctx);

  // ── Score each candidate ────────────────────────────────────────────
  const breakdown = scoreSignal(stderr, signal.exitCode);
  const noSignalCase = noSignal(stderr, signal.exitCode);

  // Subclass hint elevates framework-misbehaved by the hint baseline. The
  // no-signal penalty subtracts from the hint so callers that pass a hint
  // on an empty failure don't get a free auto-classify.
  const hintBaseline = ctx.subclassHint
    ? clamp01(
        CONFIDENCE_WEIGHTS.subclassHintBaseline -
          (noSignalCase ? CONFIDENCE_WEIGHTS.noSignalPenalty : 0),
      )
    : 0;

  // Pick the framework-misbehaved subclass with the strongest signal.
  type SubclassCandidate = { subclass: FrameworkSubclass; score: number; rationale: string };
  const subclassCandidates: SubclassCandidate[] = [
    {
      subclass: 'framework-contract-violated',
      score: breakdown.contractViolation,
      rationale: 'developer subagent returned prose / invalid JSON envelope',
    },
    {
      subclass: 'framework-sweep-incomplete',
      score: breakdown.sweepIncomplete,
      rationale: 'cleanup/sweep did not run after a failure',
    },
    {
      subclass: 'framework-silent-failure',
      score: breakdown.silentFailure,
      rationale: 'pre-dispatch filter threw without surface-visible error',
    },
    {
      subclass: 'framework-perf-regression',
      score: breakdown.perfRegression,
      rationale: 'operation took dramatically longer than baseline',
    },
  ];
  // Highest-scoring subclass — break ties by the declaration order above
  // (contract violation first because it's the highest-leverage signal).
  const bestSubclass = subclassCandidates.reduce((acc, c) => (c.score > acc.score ? c : acc), {
    subclass: subclassCandidates[0]!.subclass,
    score: 0,
    rationale: '',
  });

  // Caller hint overrides the pattern-derived subclass identity (the
  // operator has more context than the scorer) but the score floor is the
  // hint baseline. If the pattern-derived score is higher, we use it.
  const frameworkSubclass: FrameworkSubclass | undefined =
    ctx.subclassHint ?? (bestSubclass.score > 0 ? bestSubclass.subclass : undefined);
  const frameworkScore = ctx.subclassHint
    ? Math.max(hintBaseline, bestSubclass.score)
    : bestSubclass.score;
  const frameworkRationale = ctx.subclassHint
    ? bestSubclass.score > hintBaseline
      ? bestSubclass.rationale + ` (subclass hint: ${ctx.subclassHint})`
      : `caller-provided subclass hint: ${ctx.subclassHint}`
    : bestSubclass.rationale;

  // Build per-class candidates for the final winner-take-all.
  const candidates: Array<{
    class: FailureClass;
    confidence: number;
    subclass?: FrameworkSubclass;
    rationale: string;
  }> = [
    {
      class: 'external-dependency-failed',
      confidence: breakdown.externalDependency,
      rationale: 'signal matches external-dependency pattern (API outage / network / registry)',
    },
    {
      class: 'framework-misbehaved',
      confidence: frameworkScore,
      subclass: frameworkSubclass,
      rationale:
        frameworkRationale || 'framework-misbehaved patterns matched (see scoring breakdown)',
    },
    {
      class: 'operator-under-decided',
      confidence: breakdown.operatorUnderDecided,
      rationale: 'signal matches operator-under-decided pattern (DoR gap / missing AC)',
    },
  ];

  // Pick the winner: highest confidence wins; tie-break by precedence
  // (declaration order above already gives us external-dep > framework >
  // operator-under-decided when scores tie, since `reduce` keeps the first
  // when not strictly greater).
  const winner = candidates.reduce(
    (acc, c) => (c.confidence > acc.confidence ? c : acc),
    candidates[0]!,
  );

  // Apply the bucket policy.
  const confidence = winner.confidence;
  const bucket = bucketForConfidence(confidence, thresholds);

  // Render scoring breakdown for the audit trail (and unclassified
  // log-only path).
  const breakdownLine =
    `confidence=${confidence.toFixed(3)} bucket=${bucket} ` +
    `thresholds=auto≥${thresholds.autoClassify.toFixed(2)}/amb≥${thresholds.ambiguous.toFixed(2)} ` +
    `scores={ext=${breakdown.externalDependency.toFixed(2)},` +
    `op=${breakdown.operatorUnderDecided.toFixed(2)},` +
    `contract=${breakdown.contractViolation.toFixed(2)},` +
    `sweep=${breakdown.sweepIncomplete.toFixed(2)},` +
    `silent=${breakdown.silentFailure.toFixed(2)},` +
    `perf=${breakdown.perfRegression.toFixed(2)}}`;

  // ── Bucket: 'unclassified' (< ambiguous) → log-only, no surface ───
  if (bucket === 'unclassified') {
    ctx.logger?.info?.(
      `[quality-classifier] unclassified failure (no operator surface): ${breakdownLine}`,
    );
    const axes: SeverityAxes = {
      operatorTimeCost: 'low',
      blastRadius: 'low',
      frequency: 'low',
      ...ctx.severityAxes,
    };
    return {
      class: 'ambiguous',
      severity: computeSeverity(axes),
      captureRecord: null,
      rationale: `unclassified — confidence below ambiguous threshold; log-only per OQ-1 (${breakdownLine})`,
      confidence,
      bucket,
      effectiveThresholds: thresholds,
    };
  }

  // ── Bucket: 'ambiguous' (≥ ambiguous, < autoClassify) → triage ────
  if (bucket === 'ambiguous') {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'low',
      frequency: 'low',
      ...ctx.severityAxes,
    };
    return {
      class: 'ambiguous',
      severity: computeSeverity(axes),
      captureRecord: null,
      rationale: `ambiguous — confidence in mid-tier; operator triages per OQ-1 (${breakdownLine}; leading candidate: ${winner.class}${winner.subclass ? ` / ${winner.subclass}` : ''})`,
      confidence,
      bucket,
      effectiveThresholds: thresholds,
    };
  }

  // ── Bucket: 'auto-classify' (≥ autoClassify) → emit class + record ───
  // External-dependency wins → no capture record (not a framework bug).
  if (winner.class === 'external-dependency-failed') {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'low',
      frequency: 'low',
      ...ctx.severityAxes,
    };
    return {
      class: 'external-dependency-failed',
      severity: computeSeverity(axes),
      captureRecord: null,
      rationale: `${winner.rationale} (${breakdownLine})`,
      confidence,
      bucket,
      effectiveThresholds: thresholds,
    };
  }

  // Operator-under-decided wins → no capture record (routes through DoR
  // clarification flow per §5.1).
  if (winner.class === 'operator-under-decided') {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'low',
      frequency: 'low',
      ...ctx.severityAxes,
    };
    return {
      class: 'operator-under-decided',
      severity: computeSeverity(axes),
      captureRecord: null,
      rationale: `${winner.rationale} (${breakdownLine})`,
      confidence,
      bucket,
      effectiveThresholds: thresholds,
    };
  }

  // Framework-misbehaved wins (with a known subclass) → emit capture record.
  const subclass = winner.subclass!;
  const inferredAxes = inferSeverityAxes(signal, subclass);
  const axes = { ...inferredAxes, ...ctx.severityAxes } as SeverityAxes;
  const severity = computeSeverity(axes);

  // Snapshot the classification BEFORE assigning captureRecord to avoid
  // a circular reference (result → captureRecord → auditTrail →
  // classificationResult → captureRecord) that causes JSON.stringify to
  // throw inside appendFrameworkCapture's catch (silently dropping captures).
  const classificationSnap: ClassificationResult = {
    class: 'framework-misbehaved',
    subclass,
    severity,
    captureRecord: null,
    rationale: `${winner.rationale} (${breakdownLine})`,
    confidence,
    bucket,
    effectiveThresholds: thresholds,
  };

  const result: ClassificationResult = {
    class: 'framework-misbehaved',
    subclass,
    severity,
    captureRecord: {
      ts,
      class: 'framework-misbehaved',
      subclass,
      severity,
      triage: 'framework-bug',
      taskId: ctx.taskId,
      workerId: ctx.workerId,
      source: signal.source,
      auditTrail: {
        classificationResult: classificationSnap,
        originalFailure: {
          stderr: stderr.slice(0, 2000), // truncate for storage
          exitCode: signal.exitCode,
          source: signal.source,
        },
      },
    },
    rationale: `${winner.rationale} (${breakdownLine})`,
    confidence,
    bucket,
    effectiveThresholds: thresholds,
  };

  return result;
}

// Re-export the heuristic exposing function for tests and the calibration
// loop — used by `classification-calibration.ts` to recover the score
// breakdown post-hoc.
export { scoreSignal as _scoreSignal };
export { CONFIDENCE_WEIGHTS as _CONFIDENCE_WEIGHTS };
export { resolveEffectiveThresholds as _resolveEffectiveThresholds };
export { bucketForConfidence as _bucketForConfidence };

// Re-export the defaults for downstream consumers that want to display
// the shipping defaults in TUI / docs without importing both files.
export const DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS: Readonly<ClassifierConfidenceConfig> =
  Object.freeze({
    autoClassify: _DEFAULT_AUTO_CLASSIFY_THRESHOLD,
    ambiguous: _DEFAULT_AMBIGUOUS_THRESHOLD,
  });
