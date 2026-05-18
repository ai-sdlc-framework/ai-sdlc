/**
 * RFC-0025 §5 failure-mode classifier — SUBSTRATE (AISDLC-302 Phase 1).
 *
 * `classifyFailure()` takes a failure signal from a playbook handler
 * (or any pipeline checkpoint) and returns one of the four §5 taxonomy
 * classes:
 *
 *   - `operator-under-decided`    — issue genuinely lacked a decision
 *   - `framework-misbehaved`      — framework violated its own contract
 *   - `ambiguous`                 — can't tell without operator triage
 *   - `external-dependency-failed`— outside the framework's control
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 1 SUBSTRATE NOTES (AISDLC-302)
 * ─────────────────────────────────────────────────────────────────────
 * This file is salvaged from the closed PR #481 (AISDLC-270). The type
 * definitions, `computeSeverity()`, `validateVendorNamespace()`,
 * `BUILTIN_FRAMEWORK_SUBCLASSES`, the heuristic pattern lists, and
 * `ClassificationError` are correct and aligned with the operator-affirmed
 * OQ resolutions (2026-05-15).
 *
 * `classifyFailure()` uses a binary classify-or-ambiguous heuristic that
 * diverges from the operator-affirmed OQ-1 resolution (confidence-bucketed
 * classifier with per-org thresholds: ≥0.7 / 0.3–0.7 / <0.3 tiers).
 * It is preserved as a working placeholder; Phase 2 (AISDLC-303) will
 * rewrite it with the three-tier confidence-bucketed model.
 * ─────────────────────────────────────────────────────────────────────
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

export type { FailureSignal };

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
 * composite = max(operatorTimeCost, blastRadius) raised one level if
 * frequency is `high`.
 */
export function computeSeverity(axes: SeverityAxes): SeverityScore {
  const ORDER: Record<CompositeSeverity, number> = { low: 0, medium: 1, high: 2 };
  const FROM_ORDER: CompositeSeverity[] = ['low', 'medium', 'high'];

  const base = Math.max(ORDER[axes.operatorTimeCost], ORDER[axes.blastRadius]);
  const raised = axes.frequency === 'high' ? Math.min(base + 1, 2) : base;
  const composite = FROM_ORDER[raised] ?? 'low';

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
}

export interface ClassificationResult {
  class: FailureClass;
  /** Populated only when `class === 'framework-misbehaved'`. */
  subclass?: FrameworkSubclass;
  severity: SeverityScore;
  /**
   * RFC-0024 capture record for `framework-misbehaved` results.
   * `null` for other classes (no auto-routing needed).
   */
  captureRecord: FrameworkBugCaptureRecord | null;
  /** Human-readable rationale for the classification. */
  rationale: string;
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

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
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
 * Classify a framework failure signal into one of the §5 taxonomy classes.
 *
 * ⚠️  TODO(AISDLC-303 / Phase 2): This implementation uses a binary
 * classify-or-ambiguous heuristic. The operator-affirmed OQ-1 resolution
 * requires a three-tier confidence-bucketed model (≥0.7 confident /
 * 0.3–0.7 unsure / <0.3 ambiguous) with per-org configurable thresholds.
 * Phase 2 will rewrite this function with the confidence-bucketed approach.
 *
 * The default classification is `ambiguous` when the signal is inconclusive,
 * which is consistent with OQ-1 — the tier boundaries are what change.
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

  // ── 1. External-dependency patterns (highest precedence) ─────────────
  if (matchesAny(stderr, EXTERNAL_DEPENDENCY_PATTERNS)) {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'low',
      frequency: 'low',
    };
    const axes2 = { ...axes, ...ctx.severityAxes } as SeverityAxes;
    return {
      class: 'external-dependency-failed',
      severity: computeSeverity(axes2),
      captureRecord: null,
      rationale: 'signal matches external-dependency pattern (API outage / network / registry)',
    };
  }

  // ── 2. Operator-under-decided patterns ───────────────────────────────
  if (matchesAny(stderr, OPERATOR_UNDER_DECIDED_PATTERNS)) {
    const axes: SeverityAxes = {
      operatorTimeCost: 'medium',
      blastRadius: 'low',
      frequency: 'low',
    };
    const axes2 = { ...axes, ...ctx.severityAxes } as SeverityAxes;
    return {
      class: 'operator-under-decided',
      severity: computeSeverity(axes2),
      captureRecord: null,
      rationale: 'signal matches operator-under-decided pattern (DoR gap / missing AC)',
    };
  }

  // ── 3. Framework-misbehaved pattern matching ──────────────────────────
  let detectedSubclass: FrameworkSubclass | undefined = ctx.subclassHint;
  let rationale = '';

  if (!detectedSubclass) {
    if (matchesAny(stderr, CONTRACT_VIOLATION_PATTERNS)) {
      detectedSubclass = 'framework-contract-violated';
      rationale = 'developer subagent returned prose / invalid JSON envelope';
    } else if (matchesAny(stderr, SWEEP_INCOMPLETE_PATTERNS)) {
      detectedSubclass = 'framework-sweep-incomplete';
      rationale = 'cleanup/sweep did not run after a failure';
    } else if (matchesAny(stderr, SILENT_FAILURE_PATTERNS)) {
      detectedSubclass = 'framework-silent-failure';
      rationale = 'pre-dispatch filter threw without surface-visible error';
    } else if (matchesAny(stderr, PERF_REGRESSION_PATTERNS)) {
      detectedSubclass = 'framework-perf-regression';
      rationale = 'operation took dramatically longer than baseline';
    }
  } else {
    rationale = `caller-provided subclass hint: ${detectedSubclass}`;
  }

  // ── 4. If a framework subclass was detected, emit a capture record ────
  if (detectedSubclass) {
    const inferredAxes = inferSeverityAxes(signal, detectedSubclass);
    const axes = { ...inferredAxes, ...ctx.severityAxes } as SeverityAxes;
    const severity = computeSeverity(axes);

    const result: ClassificationResult = {
      class: 'framework-misbehaved',
      subclass: detectedSubclass,
      severity,
      captureRecord: null,
      rationale,
    };

    // Snapshot the classification BEFORE assigning captureRecord to avoid
    // a circular reference (result → captureRecord → auditTrail →
    // classificationResult → captureRecord) that causes JSON.stringify to
    // throw inside appendFrameworkCapture's catch (silently dropping captures).
    const classificationSnap: ClassificationResult = {
      class: 'framework-misbehaved',
      subclass: detectedSubclass,
      severity,
      captureRecord: null,
      rationale,
    };

    result.captureRecord = {
      ts,
      class: 'framework-misbehaved',
      subclass: detectedSubclass,
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
    };

    return result;
  }

  // ── 5. Default: ambiguous (OQ-1) ──────────────────────────────────────
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
    rationale:
      'classifier could not distinguish operator-under-decided from framework-misbehaved; default per OQ-1 recommendation',
  };
}
