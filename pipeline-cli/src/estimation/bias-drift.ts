/**
 * Bias drift detection — RFC-0016 §7.4 + Phase 6 (AISDLC-284).
 *
 * Detects the over-correction pattern: when the historical mean bucket
 * miss was positive (agent overestimated) but the last ≥3 consecutive
 * calibration records for the same class have all flipped to negative
 * or zero miss (underestimate or exact), the bias multiplier has been
 * over-corrected.
 *
 * RFC §7.4:
 * > "If after adjustment the mean miss flips sign (consistently
 * > underestimated post-adjustment), the bias multiplier was
 * > over-corrected. Phase 3 emits a `EstimateBiasOverCorrected` event
 * > when this pattern persists for ≥3 consecutive estimates."
 *
 * ## Algorithm
 *
 * For each task class, the detector:
 *  1. Reads all calibration records for the class (across all
 *     monthly-rotated files) ordered by timestamp.
 *  2. Computes the mean bucket miss over all records ("overall bias").
 *  3. Takes the last N consecutive records (default N=3) — the "recent
 *     window".
 *  4. Declares over-correction when:
 *     - Overall mean > 0 (historical overestimate bias is present) AND
 *     - All records in the recent window have `bucketMiss ≤ 0` (every
 *       recent record is an underestimate or exact).
 *  5. Emits `EstimateBiasOverCorrected` (RFC-0015 gated, best-effort).
 *
 * The detector is idempotent across processes: calling it twice on the
 * same calibration state produces at most one event. Idempotency is
 * enforced via a `windowSignature` — the SHA-256 of the sorted
 * `taskId@ts` tuples of the tail window that triggered detection. Before
 * emitting, the detector scans the date-rotated events files for an
 * existing event with the same `taskClass` + `windowSignature`. If found,
 * the call returns `alreadyEmitted: true` and skips the write. A new
 * over-correction event fires only when fresh calibration records extend
 * the window (changing the signature).
 *
 * Best-effort I/O: failures are surfaced via the optional logger but
 * never rethrown — a disk hiccup can't interrupt the pipeline.
 *
 * @module estimation/bias-drift
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeEvent } from '../orchestrator/events.js';
import type { PipelineLogger } from '../types.js';
import { type TaskClass, TASK_CLASSES } from './types.js';
import type { CalibrationRecord } from './calibration-writer.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface DetectBiasDriftOpts {
  /**
   * Task class to check. When omitted, all non-`uncategorized` classes
   * are checked in sequence.
   */
  taskClass?: TaskClass;
  /**
   * Minimum number of consecutive sign-flipped records required to
   * declare over-correction. Default: 3.
   */
  consecutiveThreshold?: number;
  /** Override for the artifacts directory. */
  artifactsDir?: string;
  /** Optional clock override for the emitted event's `ts` field. */
  now?: () => Date;
  /** Optional logger for best-effort I/O errors. */
  logger?: PipelineLogger;
}

export interface DriftCheckResult {
  /** Task class that was checked. */
  taskClass: TaskClass;
  /**
   * Whether over-correction was detected for this class:
   * overall mean > 0 AND all N consecutive recent records ≤ 0.
   */
  overCorrected: boolean;
  /** Total number of calibration records for this class. */
  totalRecords: number;
  /** Mean bucket miss over ALL records (positive = historical overestimate). */
  meanMissOverall: number;
  /**
   * Mean bucket miss over the recent window (the last
   * `consecutiveThreshold` records).
   */
  meanMissRecent: number;
  /**
   * Number of consecutive records at the tail of the series that have
   * `bucketMiss ≤ 0`.
   */
  consecutiveNonPositive: number;
  /** Whether a `EstimateBiasOverCorrected` event was emitted in this call. */
  eventEmitted: boolean;
  /**
   * Whether a `EstimateBiasOverCorrected` event had already been emitted
   * for this calibration window in a previous call. When `true`,
   * `eventEmitted` is `false` (we did not re-emit the duplicate).
   *
   * Idempotency key: the SHA-256 of the concatenated `taskId@ts` tuples of
   * the tail records that triggered the over-correction detection, stored
   * as `windowSignature` on the emitted event. A second call with the same
   * calibration state (same tail records) finds the matching event in
   * `_orchestrator/events-*.jsonl` and short-circuits.
   */
  alreadyEmitted: boolean;
  /**
   * The window-level idempotency fingerprint (present when
   * `overCorrected === true`). Included in the emitted event payload so
   * that subsequent calls can de-duplicate without re-analysing all records.
   */
  windowSignature?: string;
}

export interface DetectBiasDriftResult {
  /** One result per checked class. */
  checks: DriftCheckResult[];
  /** How many classes triggered the over-correction event. */
  overCorrectedCount: number;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Scan calibration records and emit `EstimateBiasOverCorrected` events
 * when the over-correction pattern is detected.
 *
 * Corpus-driven (NOT calendar-gated): call this from the weekly digest
 * sweep, from `cli-estimate show <class>`, or from any post-merge hook
 * that records calibration data.
 *
 * Returns a structured report useful for the weekly digest and the
 * `cli-estimate coverage` subcommand.
 */
export function detectBiasDrift(opts: DetectBiasDriftOpts = {}): DetectBiasDriftResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const threshold = Math.max(1, opts.consecutiveThreshold ?? 3);
  const classesToCheck: TaskClass[] = opts.taskClass
    ? [opts.taskClass]
    : (TASK_CLASSES.filter((c) => c !== 'uncategorized') as TaskClass[]);

  const checks: DriftCheckResult[] = [];

  for (const taskClass of classesToCheck) {
    const records = readCalibrationRecords(artifactsDir, taskClass);
    const check = analyzeClass(taskClass, records, threshold);

    let eventEmitted = false;
    let alreadyEmitted = false;
    let windowSignature: string | undefined;

    if (check.overCorrected) {
      // Sort ascending so the tail slice is deterministic.
      const sorted = [...records].sort(
        (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
      );
      windowSignature = computeWindowSignature(sorted, threshold);

      // Idempotency: only emit if no event with this windowSignature exists yet.
      if (hasOverCorrectedEventInHistory(artifactsDir, taskClass, windowSignature)) {
        alreadyEmitted = true;
      } else {
        eventEmitted = writeEvent(
          {
            ts: (opts.now ?? ((): Date => new Date()))().toISOString(),
            type: 'EstimateBiasOverCorrected',
            taskClass,
            consecutiveMisses: check.consecutiveNonPositive,
            meanMissOverall: check.meanMissOverall,
            meanMissRecent: check.meanMissRecent,
            windowSignature,
          },
          { artifactsDir, now: opts.now, logger: opts.logger },
        );
      }
    }

    checks.push({ ...check, eventEmitted, alreadyEmitted, windowSignature });
  }

  const overCorrectedCount = checks.filter((c) => c.overCorrected).length;
  return { checks, overCorrectedCount };
}

// ── Analysis ──────────────────────────────────────────────────────────────

// Pure-analysis return type — excludes I/O fields (eventEmitted, alreadyEmitted, windowSignature)
// that the caller sets based on the event-history check.
type AnalysisResult = Omit<DriftCheckResult, 'eventEmitted' | 'alreadyEmitted' | 'windowSignature'>;

function analyzeClass(
  taskClass: TaskClass,
  records: CalibrationRecord[],
  threshold: number,
): AnalysisResult {
  const base: AnalysisResult = {
    taskClass,
    overCorrected: false,
    totalRecords: records.length,
    meanMissOverall: 0,
    meanMissRecent: 0,
    consecutiveNonPositive: 0,
  };

  if (records.length < threshold) {
    // Not enough data to make the assessment.
    return base;
  }

  // Sort by timestamp ascending (oldest first) so the tail is the most-recent.
  const sorted = [...records].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const meanMissOverall = sorted.reduce((sum, r) => sum + r.bucketMiss, 0) / sorted.length;

  // Count consecutive non-positive records from the tail.
  let consecutiveNonPositive = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.bucketMiss <= 0) {
      consecutiveNonPositive++;
    } else {
      break;
    }
  }

  // Recent window mean (last `threshold` records).
  const recentWindow = sorted.slice(-threshold);
  const meanMissRecent =
    recentWindow.reduce((sum, r) => sum + r.bucketMiss, 0) / recentWindow.length;

  // Over-correction: historical bias is positive but recent window is all ≤ 0.
  const overCorrected = meanMissOverall > 0 && consecutiveNonPositive >= threshold;

  return {
    taskClass,
    overCorrected,
    totalRecords: sorted.length,
    meanMissOverall,
    meanMissRecent,
    consecutiveNonPositive,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function resolveArtifactsDir(explicit: string | undefined): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

/**
 * Compute a stable fingerprint for the tail window of calibration records
 * that triggered over-correction detection. Used as the idempotency key
 * stored on the emitted `EstimateBiasOverCorrected` event.
 *
 * The signature is the SHA-256 hex of the sorted `taskId@ts` tuples of
 * the last `windowSize` records (already sorted ascending by `ts` by the
 * caller). Sorting the tuples makes the fingerprint order-independent
 * within the window, which is robust against records being rewritten with
 * the same logical content but different physical ordering.
 */
function computeWindowSignature(sortedRecords: CalibrationRecord[], windowSize: number): string {
  const tail = sortedRecords.slice(-windowSize);
  const canonical = tail
    .map((r) => `${r.taskId}@${r.ts}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Scan the date-rotated events files for an existing
 * `EstimateBiasOverCorrected` event that matches `taskClass` and
 * `windowSignature`. Returns `true` when found (caller should skip
 * re-emission).
 *
 * Best-effort: any I/O error returns `false` (allow re-emission rather
 * than silently swallowing a legitimate event).
 */
function hasOverCorrectedEventInHistory(
  artifactsDir: string,
  taskClass: TaskClass,
  windowSignature: string,
): boolean {
  const dir = join(artifactsDir, '_orchestrator');
  if (!existsSync(dir)) return false;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return false;
  }

  for (const fileName of files) {
    const filePath = join(dir, fileName);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (
          event.type === 'EstimateBiasOverCorrected' &&
          event.taskClass === taskClass &&
          event.windowSignature === windowSignature
        ) {
          return true;
        }
      } catch {
        // Malformed line — skip silently.
      }
    }
  }
  return false;
}

function readCalibrationRecords(artifactsDir: string, taskClass: TaskClass): CalibrationRecord[] {
  const estimatesDir = join(artifactsDir, '_estimates');
  if (!existsSync(estimatesDir)) return [];

  let files: string[];
  try {
    files = readdirSync(estimatesDir)
      .filter((f) => /^calibration-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => join(estimatesDir, f));
  } catch {
    return [];
  }

  const records: CalibrationRecord[] = [];
  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CalibrationRecord;
        if (
          r &&
          typeof r === 'object' &&
          typeof r.taskId === 'string' &&
          typeof r.actualBucket === 'string' &&
          r.class === taskClass
        ) {
          records.push(r);
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}
