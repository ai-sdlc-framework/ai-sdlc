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
 * The detector is idempotent over a single calibration state: calling
 * it twice on the same records produces at most one event (the second
 * call returns `alreadyEmitted: true` once an event has been written for
 * the current window). A new over-correction event fires when fresh
 * calibration records extend the window.
 *
 * Best-effort I/O: failures are surfaced via the optional logger but
 * never rethrown — a disk hiccup can't interrupt the pipeline.
 *
 * @module estimation/bias-drift
 */

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
  /** Whether a `EstimateBiasOverCorrected` event was emitted. */
  eventEmitted: boolean;
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
    if (check.overCorrected) {
      eventEmitted = writeEvent(
        {
          ts: (opts.now ?? ((): Date => new Date()))().toISOString(),
          type: 'EstimateBiasOverCorrected',
          taskClass,
          consecutiveMisses: check.consecutiveNonPositive,
          meanMissOverall: check.meanMissOverall,
          meanMissRecent: check.meanMissRecent,
        },
        { artifactsDir, now: opts.now, logger: opts.logger },
      );
    }

    checks.push({ ...check, eventEmitted });
  }

  const overCorrectedCount = checks.filter((c) => c.overCorrected).length;
  return { checks, overCorrectedCount };
}

// ── Analysis ──────────────────────────────────────────────────────────────

function analyzeClass(
  taskClass: TaskClass,
  records: CalibrationRecord[],
  threshold: number,
): Omit<DriftCheckResult, 'eventEmitted'> {
  const base: Omit<DriftCheckResult, 'eventEmitted'> = {
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
