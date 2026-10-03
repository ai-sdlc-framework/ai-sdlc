/**
 * Review plan types and the narrowest risk-map input the baseline checklist needs.
 *
 * INPUT CONTRACT: {@link RiskMapInput} is defined here, structurally, and is the
 * only thing the checklist reads. The real risk map produced by the risk-map
 * stage must satisfy it, and a conformance test in the risk-map task
 * (AISDLC-672) is required to keep the two in step. This module deliberately
 * does not import that stage's schema.
 *
 * @module review-plan/types
 */

export const PROBE_TYPES = ['read', 'trace', 'run', 'compare', 'search'] as const;
export type ProbeType = (typeof PROBE_TYPES)[number];

export const SECURITY_CATEGORIES = [
  'authentication',
  'authorization',
  'input-handling',
  'secrets',
  'shell-or-path',
  'manifest-or-workflow',
] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

export type FileClass =
  | 'source'
  | 'test'
  | 'config'
  | 'workflow'
  | 'docs'
  | 'lockfile'
  | 'migration'
  | 'manifest';

export interface ProbeFileRef {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ProbeTarget {
  files?: ProbeFileRef[];
  symbols?: string[];
  command?: string;
  revisions?: { base: string; head: string };
  query?: string;
}

export interface Probe {
  id: string;
  type: ProbeType;
  target: ProbeTarget;
  question: string;
  covers: string[];
  baseline?: boolean;
}

export interface ReviewPlan {
  schemaVersion: 1;
  baselineVersion: string;
  probes: Probe[];
}

export interface RiskHunk {
  id: string;
  file: string;
  fileClass: FileClass;
  startLine: number;
  endLine: number;
  /** 0..1. Compared against the configured risk threshold. */
  riskScore: number;
  /** False when the judgment layer abstained. Unjudged hunks count as high risk. */
  judged: boolean;
  /** Categories the judgment layer flagged for this hunk. */
  flags: readonly SecurityCategory[];
  /** Changed symbols, when known. */
  symbols?: readonly string[];
}

export interface RiskCriterion {
  id: string;
  text: string;
  /** True when the coverage judgment marked this criterion likely uncovered. */
  likelyUncovered: boolean;
}

export interface RiskSourceFile {
  path: string;
  /** Changed test files that exercise this source file. Empty when no test changed. */
  changedTests: readonly string[];
}

/** The narrowest structural view of the risk map the checklist needs. */
export interface RiskMapInput {
  hunks: readonly RiskHunk[];
  criteria: readonly RiskCriterion[];
  changedSourceFiles: readonly RiskSourceFile[];
  changedTestFiles: readonly string[];
  /** Every changed file path, used for the out-of-scope search probe. */
  changedFiles: readonly string[];
}

export interface TaskInput {
  /** The task's declared references (file paths or directory prefixes). */
  references: readonly string[];
}

export interface Baseline {
  version: string;
  probes: Probe[];
}

export type RejectionReason =
  | 'schema-invalid'
  | 'baseline-version-mismatch'
  | 'duplicate-probe-id'
  | 'missing-baseline-probe'
  | 'modified-baseline-probe'
  | 'unknown-baseline-probe'
  | 'unknown-hunk'
  | 'uncovered-high-risk-hunk'
  | 'probe-limit-exceeded'
  | 'target-size-exceeded'
  | 'run-target-not-allowed'
  | 'unsafe-path'
  | 'run-files-not-changed-tests'
  | 'baseline-over-ceiling'
  | 'unsafe-query'
  | 'duplicate-run-probe'
  | 'unsafe-revision'
  | 'unreviewable-input';

export interface Rejection {
  reason: RejectionReason;
  probeId?: string;
  detail: string;
}

export interface PlanLimits {
  riskThreshold: number;
  /**
   * Cap on the probes the PLAN adds beyond the baseline. The baseline is
   * mandatory and is not capped by this limit; it is bounded only by the
   * absolute ceilings in `validate.ts`.
   */
  maxProbes: number;
  /** Cap, in bytes, on the serialized targets of the probes the plan adds beyond the baseline. */
  maxTargetBytes: number;
  /** Exact command strings a `run` probe may name. */
  commandAllowlist: readonly string[];
  /**
   * Repository root. Required: file targets are checked against the real
   * filesystem, and a path that resolves (through symlinks) outside this root,
   * or whose root cannot be resolved, is rejected.
   */
  repoRoot: string;
  /**
   * The merge-base commit SHA, supplied by code (never by the plan). A `compare` probe may
   * diff exactly this revision against `HEAD` and nothing else, so a plan cannot name another
   * local ref (a branch, the shared stash, a tag). When absent or not a full lowercase hex SHA,
   * every plan-supplied `revisions` is refused.
   */
  mergeBase?: string;
  /**
   * Cap on the `run` probes the plan adds beyond the baseline, independent of `maxProbes`
   * (each run probe executes the repository's own scripts). Defaults to
   * `DEFAULT_MAX_RUN_PROBES`.
   */
  maxRunProbes?: number;
}

export type ValidatePlanResult = { valid: true } | { valid: false; rejections: Rejection[] };
