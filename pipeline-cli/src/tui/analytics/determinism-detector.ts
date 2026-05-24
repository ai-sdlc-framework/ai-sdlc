/**
 * RFC-0025 §6 / OQ-7 — framework-determinism-violated detection.
 * SUBSTRATE (AISDLC-302 Phase 1 / salvaged from PR #481).
 * Composite sampling (AISDLC-306 Phase 5).
 *
 * The `framework-determinism-violated` subclass detects when the same
 * task input produces different outputs across two dispatches. The
 * detection mechanism is sampled to control cost.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 5 COMPOSITE SAMPLING (AISDLC-306 / OQ-7)
 * ─────────────────────────────────────────────────────────────────────
 * The operator-affirmed OQ-7 resolution (2026-05-15) requires composite
 * sampling: flat baseline rate (default 1-in-50) + always-on for tasks
 * marked `requires-determinism: true` + always-on for tasks in the
 * top-decile blast-radius cohort (composes with RFC-0014 dep-graph
 * snapshot's `effectivePriority`).
 *
 * Two entry points:
 *   - `shouldSampleDeterminism(dispatchCount, requiresDeterminism)` — the
 *     Phase 1 substrate entry point. Backward-compatible flat 1-in-50.
 *     Preserved for callers that don't yet have blast-radius context.
 *   - `shouldSampleDeterminismComposite(opts)` — the Phase 5 entry point.
 *     Accepts a blast-radius signal + per-org config and applies the full
 *     composite policy. Recommended for new callers.
 * ─────────────────────────────────────────────────────────────────────
 *
 * The detector compares two structured outputs for the same `taskId`:
 *   - `filesChanged`: sorted list of file paths modified
 *   - `commitSubject`: the commit message subject line
 *
 * A mismatch in either is classified as a potential determinism violation.
 * The comparison is probabilistic — different file orderings in the same
 * logical change would NOT fire (because we sort), but different files
 * changed for the same semantic goal WOULD fire.
 *
 * Usage:
 *   The orchestrator loop calls `shouldSampleDeterminism(dispatchCount)`
 *   before a dispatch, and if true, stores the result via
 *   `recordDeterminismBaseline()`. On a subsequent re-dispatch of the
 *   same task, `checkDeterminismViolation()` compares against the stored
 *   baseline.
 *
 * Storage:
 *   Baselines are stored in `$ARTIFACTS_DIR/_quality/determinism/`
 *   as `<task-id-lower>.json` files. Files are pruned after 7 days
 *   automatically on each write to keep the directory bounded.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { resolveArtifactsDir } from '../sources/types.js';

// ── Constants ──────────────────────────────────────────────────────────

export const DETERMINISM_SAMPLE_RATE = 50; // 1-in-50
export const DETERMINISM_DIR = '_quality/determinism';
export const BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Baseline record ────────────────────────────────────────────────────

export interface DeterminismBaseline {
  taskId: string;
  /** ISO-8601 timestamp of this baseline dispatch. */
  ts: string;
  dispatchCount: number;
  /** Sorted list of file paths modified in this dispatch. */
  filesChanged: string[];
  /** Commit subject line. */
  commitSubject: string;
  /** Whether the task has `requires-determinism: true`. */
  requiresDeterminism: boolean;
}

// ── Detection result ──────────────────────────────────────────────────

export interface DeterminismCheckResult {
  violated: boolean;
  taskId: string;
  reason?: string;
  /** The stored baseline. */
  baseline?: DeterminismBaseline;
  /** Current dispatch's output fingerprint. */
  current?: Pick<DeterminismBaseline, 'filesChanged' | 'commitSubject'>;
}

// ── Sampling logic ────────────────────────────────────────────────────

/**
 * Decide whether to sample determinism for this dispatch using the flat
 * 1-in-50 baseline policy (the Phase 1 substrate behavior).
 *
 * @param dispatchCount - Monotonically increasing counter from the
 *   orchestrator loop. 1-indexed.
 * @param requiresDeterminism - Whether the task explicitly opts in.
 *
 * For Phase 5 composite sampling (always-on for top-decile blast-radius
 * tasks per OQ-7), use {@link shouldSampleDeterminismComposite}.
 */
export function shouldSampleDeterminism(
  dispatchCount: number,
  requiresDeterminism: boolean,
): boolean {
  if (requiresDeterminism) return true;
  return dispatchCount % DETERMINISM_SAMPLE_RATE === 0;
}

/**
 * Composite sampling input — combines per-dispatch counter, task opt-in,
 * and blast-radius signal from RFC-0014 dep-graph snapshot.
 *
 * `blastRadiusEffectivePriority` is the `effectivePriority` field from the
 * latest deps snapshot record for the task being dispatched. When the
 * value falls in the top-decile of the corpus (as reported by
 * `isTopDecileBlastRadius()`), the dispatch is always sampled.
 *
 * `defaultSampleRate` is the configured sample rate as a fraction (0..1).
 * Defaults to {@link DETERMINISM_SAMPLE_FRACTION} (0.02 = 1-in-50). A rate
 * of 0 disables flat sampling entirely (only the always-on rules fire).
 *
 * `alwaysOnRequiresDeterminism` honors the `requires-determinism: true`
 * task opt-in. `alwaysOnTopBlastRadiusDecile` enables the blast-radius
 * always-on rule (composes with RFC-0014). Both default to `true` per
 * §13.1 / OQ-7.
 */
export interface ShouldSampleDeterminismCompositeOpts {
  /** 1-indexed monotonic dispatch counter from the orchestrator loop. */
  dispatchCount: number;
  /** Whether the task has `requires-determinism: true` in its frontmatter. */
  requiresDeterminism: boolean;
  /**
   * RFC-0014 effectivePriority for this task, or null when no snapshot is
   * available (composition layer disabled / task not yet in graph).
   */
  blastRadiusEffectivePriority: number | null;
  /**
   * Whether this task's effectivePriority places it in the top-decile of
   * the corpus per `isTopDecileBlastRadius()`. Callers compute this once
   * per tick (or once per snapshot read) and pass in.
   */
  isTopBlastRadiusDecile: boolean;
  /**
   * Configured sample rate as a fraction (0..1). Defaults to
   * `DETERMINISM_SAMPLE_FRACTION` (0.02 = 1-in-50). 0 disables flat
   * sampling (only always-on rules fire).
   */
  defaultSampleRate?: number;
  /** Whether the `requires-determinism: true` always-on rule is enabled. Default true. */
  alwaysOnRequiresDeterminism?: boolean;
  /** Whether the top-decile blast-radius always-on rule is enabled. Default true. */
  alwaysOnTopBlastRadiusDecile?: boolean;
}

/**
 * Reason a composite-sampling decision returned `true` — useful for the
 * orchestrator's events.jsonl audit trail.
 */
export type DeterminismSampleReason =
  | 'requires-determinism-flag'
  | 'top-decile-blast-radius'
  | 'flat-sample-rate'
  | 'not-sampled';

export interface DeterminismCompositeDecision {
  sample: boolean;
  reason: DeterminismSampleReason;
}

/**
 * Phase 5 (AISDLC-306) — composite sampling per OQ-7. Returns `true` when
 * ANY of these gates fire:
 *
 *   1. `requires-determinism: true` task opt-in (alwaysOn).
 *   2. Top-decile blast-radius (alwaysOn, composes with RFC-0014).
 *   3. Flat sample rate (default 1-in-50 / 0.02 fraction).
 *
 * The returned `reason` reflects the first gate that fired so callers can
 * surface the audit trail to events.jsonl + cli-status.
 */
export function shouldSampleDeterminismComposite(
  opts: ShouldSampleDeterminismCompositeOpts,
): DeterminismCompositeDecision {
  const alwaysOnRequires = opts.alwaysOnRequiresDeterminism ?? true;
  const alwaysOnTopDecile = opts.alwaysOnTopBlastRadiusDecile ?? true;
  const sampleRate = opts.defaultSampleRate ?? DETERMINISM_SAMPLE_FRACTION;

  if (alwaysOnRequires && opts.requiresDeterminism) {
    return { sample: true, reason: 'requires-determinism-flag' };
  }
  if (alwaysOnTopDecile && opts.isTopBlastRadiusDecile) {
    return { sample: true, reason: 'top-decile-blast-radius' };
  }
  // Flat sampling — treat the rate as 1-in-N where N = round(1/rate). Use
  // the integer divisor so the existing 1-in-50 callers see identical
  // behavior (50 % 50 === 0). Rate of 0 disables flat sampling entirely.
  if (sampleRate > 0) {
    const divisor = Math.max(1, Math.round(1 / sampleRate));
    if (opts.dispatchCount > 0 && opts.dispatchCount % divisor === 0) {
      return { sample: true, reason: 'flat-sample-rate' };
    }
  }
  return { sample: false, reason: 'not-sampled' };
}

/**
 * Default sample rate as a fraction (0..1). Matches the `1 / DETERMINISM_SAMPLE_RATE`
 * convention from the Phase 1 substrate (1-in-50 = 0.02).
 */
export const DETERMINISM_SAMPLE_FRACTION = 1 / DETERMINISM_SAMPLE_RATE;

/**
 * Compute the top-decile cutoff for blast-radius `effectivePriority` values
 * across a corpus of dependency-graph snapshot records, and return whether
 * a given task's effectivePriority falls in that cohort.
 *
 * Implementation: take the 90th-percentile value (nearest-rank method) of
 * the sorted-ascending `effectivePriority` distribution; a task is in the
 * top decile iff its value is `>= cutoff`. Ties at the cutoff are
 * included in the top decile (the OQ-7 resolution favors over-sampling at
 * the boundary; missing a top-decile task is worse than over-sampling).
 *
 * @param corpusPriorities - All `effectivePriority` values from the
 *   current snapshot. Empty / null / NaN entries are filtered.
 * @param candidatePriority - The candidate task's effectivePriority, or
 *   `null` if the task is not in the snapshot.
 * @returns `false` when the corpus is empty, `candidatePriority` is null,
 *   or when the candidate falls below the 90th-percentile cutoff.
 */
export function isTopDecileBlastRadius(
  corpusPriorities: readonly (number | null | undefined)[],
  candidatePriority: number | null | undefined,
): boolean {
  if (candidatePriority === null || candidatePriority === undefined) return false;
  if (!Number.isFinite(candidatePriority)) return false;

  const valid: number[] = [];
  for (const p of corpusPriorities) {
    if (typeof p === 'number' && Number.isFinite(p)) valid.push(p);
  }
  if (valid.length === 0) return false;

  // Nearest-rank 90th percentile.
  const sorted = valid.slice().sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length) - 1;
  const cutoff = sorted[Math.max(0, Math.min(rank, sorted.length - 1))] ?? sorted[0] ?? 0;

  return candidatePriority >= cutoff;
}

// ── Baseline storage ──────────────────────────────────────────────────

function baselinePath(artifactsDir: string, taskId: string): string {
  return join(
    resolveArtifactsDir({ artifactsDir }),
    DETERMINISM_DIR,
    `${taskId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.json`,
  );
}

function ensureDeterminismDir(artifactsDir: string): string {
  const dir = join(resolveArtifactsDir({ artifactsDir }), DETERMINISM_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Prune baseline files older than `BASELINE_MAX_AGE_MS`. Called on every
 * write so the directory stays bounded without a separate cron job.
 */
function pruneOldBaselines(artifactsDir: string, now: Date): void {
  const dir = join(resolveArtifactsDir({ artifactsDir }), DETERMINISM_DIR);
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const p = join(dir, entry);
    try {
      const s = statSync(p);
      if (now.getTime() - s.mtime.getTime() > BASELINE_MAX_AGE_MS) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

/**
 * Persist a determinism baseline for a task dispatch.
 * Called after a successful dispatch when `shouldSampleDeterminism` returned true.
 */
export function recordDeterminismBaseline(
  baseline: DeterminismBaseline,
  opts: { artifactsDir?: string; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  ensureDeterminismDir(opts.artifactsDir ?? '');
  pruneOldBaselines(opts.artifactsDir ?? '', now);
  const path = baselinePath(opts.artifactsDir ?? '', baseline.taskId);
  try {
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  } catch {
    // best-effort — determinism recording should never crash the loop
  }
}

/**
 * Read the stored baseline for a task, or `null` if none exists.
 */
export function readDeterminismBaseline(
  taskId: string,
  opts: { artifactsDir?: string } = {},
): DeterminismBaseline | null {
  const path = baselinePath(opts.artifactsDir ?? '', taskId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as DeterminismBaseline;
  } catch {
    return null;
  }
}

// ── Comparison logic ──────────────────────────────────────────────────

/**
 * Compare a current dispatch output against a stored baseline.
 *
 * Returns `{ violated: true }` when:
 *   - The set of changed files differs (sorted comparison).
 *   - OR the commit subject differs (normalized: trimmed, case-sensitive).
 *
 * Returns `{ violated: false }` when the outputs match or when no
 * baseline exists (the absence is not itself a violation).
 */
export function checkDeterminismViolation(
  taskId: string,
  current: Pick<DeterminismBaseline, 'filesChanged' | 'commitSubject'>,
  opts: { artifactsDir?: string } = {},
): DeterminismCheckResult {
  const baseline = readDeterminismBaseline(taskId, opts);
  if (!baseline) {
    return { violated: false, taskId };
  }

  const sortedBaseline = [...baseline.filesChanged].sort();
  const sortedCurrent = [...current.filesChanged].sort();

  const filesDiffer =
    sortedBaseline.length !== sortedCurrent.length ||
    sortedBaseline.some((f, i) => f !== sortedCurrent[i]);

  const subjectDiffer = baseline.commitSubject.trim() !== current.commitSubject.trim();

  if (filesDiffer || subjectDiffer) {
    const reasons: string[] = [];
    if (filesDiffer) {
      reasons.push(
        `files changed differ (baseline: [${sortedBaseline.join(', ')}], current: [${sortedCurrent.join(', ')}])`,
      );
    }
    if (subjectDiffer) {
      reasons.push(
        `commit subject differs (baseline: "${baseline.commitSubject.trim()}", current: "${current.commitSubject.trim()}")`,
      );
    }
    return {
      violated: true,
      taskId,
      reason: reasons.join('; '),
      baseline,
      current,
    };
  }

  return { violated: false, taskId, baseline, current };
}
