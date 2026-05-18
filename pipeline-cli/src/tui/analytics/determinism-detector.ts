/**
 * RFC-0025 §6 / OQ-7 — framework-determinism-violated detection.
 * SUBSTRATE (AISDLC-302 Phase 1 / salvaged from PR #481).
 *
 * The `framework-determinism-violated` subclass detects when the same
 * task input produces different outputs across two dispatches. The
 * detection mechanism is sampled to control cost.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 1 SUBSTRATE NOTES (AISDLC-302)
 * ─────────────────────────────────────────────────────────────────────
 * Types, baseline record/storage logic (`recordDeterminismBaseline`,
 * `readDeterminismBaseline`), and `checkDeterminismViolation()` are
 * fully aligned with operator-affirmed resolutions and are kept intact.
 *
 * ⚠️  TODO(AISDLC-306 / Phase 5 / OQ-7): `shouldSampleDeterminism()`
 * uses flat 1-in-50 sampling. The operator-affirmed OQ-7 resolution
 * requires a COMPOSITE approach: flat sampling PLUS always-on for tasks
 * with high blast-radius (composes with RFC-0014 blast-radius scores).
 * Phase 5 will extend this function to accept a blast-radius score and
 * apply risk-based escalation on top of the base sampling rate.
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
 * Decide whether to sample determinism for this dispatch.
 *
 * @param dispatchCount - Monotonically increasing counter from the
 *   orchestrator loop. 1-indexed.
 * @param requiresDeterminism - Whether the task explicitly opts in.
 *
 * ⚠️  TODO(AISDLC-306 / Phase 5 / OQ-7): Phase 5 adds a `blastRadiusScore`
 * parameter from RFC-0014 so high-blast-radius tasks are always sampled
 * (composite approach per operator-affirmed OQ-7 resolution).
 */
export function shouldSampleDeterminism(
  dispatchCount: number,
  requiresDeterminism: boolean,
): boolean {
  if (requiresDeterminism) return true;
  return dispatchCount % DETERMINISM_SAMPLE_RATE === 0;
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
