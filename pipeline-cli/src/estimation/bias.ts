/**
 * Bias computation + 3-state token formatter — RFC-0016 Phase 5 (AISDLC-283).
 *
 * ## Per-class bias statistics (RFC §7.1)
 *
 * `computeBiasStats()` reads the monthly-rotated calibration JSONL files
 * and returns per-class statistics:
 *  - mean bucket miss (positive = overestimate bias)
 *  - median bucket miss
 *  - per-agent (`predictedBy`) stratification (Q2 resolution)
 *
 * ## Stage A vs Stage B accuracy comparison (RFC §13 Phase 5 AC #1)
 *
 * `computeStageAVsStageBAccuracy()` joins log.jsonl rows with calibration
 * records by taskId to produce:
 *  - Stage A solo accuracy: fraction of tasks where Stage A's candidateBucket
 *    matched the actual bucket (i.e. Stage B was not invoked OR Stage B agreed)
 *  - Stage B improvement rate: fraction of Stage-B-invoked rows where Stage B's
 *    bucket was CLOSER to the actual than Stage A's
 *
 * ## 3-state token (Q6 resolution — RFC §7.3)
 *
 * `formatStateToken()` is the SINGLE SOURCE OF TRUTH for rendering the Q6 state
 * token across all four surfaces:
 *  - PR comment (`<!-- ai-sdlc:estimate -->`)
 *  - `cli-estimate show <class>` CLI output
 *  - Dashboard (future)
 *  - Slack #estimation-review (future)
 *
 * States:
 *  | State         | Condition   | Format                              |
 *  |---------------|-------------|-------------------------------------|
 *  | `uncalibrated`| n = 0       | `(uncalibrated)`                    |
 *  | `warming`     | 1 ≤ n < 5   | `(warming, n=N)`                    |
 *  | `calibrated`  | n ≥ 5       | `(calibrated, n=N, bias=±X%)`       |
 *
 * Variance qualifier (Q5 connection): when `estimateVariance ≥ 2`, append
 * `; high-variance` even when calibrated:
 *  `(calibrated, n=23, bias=+15%; high-variance)`
 *
 * @module estimation/bias
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUCKET_INDEX } from './types.js';
import type { Bucket, TaskClass } from './types.js';
import type { CalibrationRecord } from './calibration-writer.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── 3-state token (Q6 resolution) ────────────────────────────────────────────

/**
 * RFC §7.3 calibration state enum.
 * - `uncalibrated` — n = 0 (no calibration data for the class)
 * - `warming`      — 1 ≤ n < 5 (accumulating but below the 5-sample threshold)
 * - `calibrated`   — n ≥ 5 (enough data to trust the bias estimate)
 */
export type CalibrationState = 'uncalibrated' | 'warming' | 'calibrated';

/**
 * Compute the calibration state for `n` sample pairs.
 * Pure function — no I/O.
 */
export function calibrationStateFor(n: number): CalibrationState {
  if (n === 0) return 'uncalibrated';
  if (n < 5) return 'warming';
  return 'calibrated';
}

/**
 * Format the RFC §7.3 3-state token.
 *
 * This is the SINGLE SOURCE OF TRUTH renderer — all four surfaces (PR
 * comment, CLI, dashboard, Slack) call this function. No surface-specific
 * parsing, just one string.
 *
 * @param n              Number of calibration sample pairs for the class.
 * @param meanBucketMiss Signed mean bucket miss (positive = overestimate).
 *                       Used only when state = `calibrated`. Pass `null`
 *                       when not available (omits the `bias=` fragment).
 * @param estimateVariance RFC §8.4 variance across the current same-hash
 *                       batch. When ≥ 2, appends `; high-variance` qualifier.
 *                       Pass 0 or omit when not applicable.
 */
export function formatStateToken(
  n: number,
  meanBucketMiss?: number | null,
  estimateVariance?: number,
): string {
  const state = calibrationStateFor(n);
  const highVariance = (estimateVariance ?? 0) >= 2;

  if (state === 'uncalibrated') {
    return '(uncalibrated)';
  }

  if (state === 'warming') {
    return highVariance ? `(warming, n=${n}; high-variance)` : `(warming, n=${n})`;
  }

  // state === 'calibrated'
  // `formatBiasPercent` already includes the sign (e.g. "+15%" or "-15%"),
  // so we must NOT prepend an extra sign character here.
  const biasFragment = meanBucketMiss != null ? `, bias=${formatBiasPercent(meanBucketMiss)}` : '';
  const varianceFragment = highVariance ? '; high-variance' : '';
  return `(calibrated, n=${n}${biasFragment}${varianceFragment})`;
}

/**
 * Convert a mean bucket miss (0–4 scale) to a bias percentage.
 *
 * Formula: `biasPercent = round((meanBucketMiss / 4) × 100)`
 *
 * Rationale: the bucket scale spans 0–4 (XS=0 to XL=4); dividing by 4
 * normalises the miss to a 0–100% range. A +0.6 mean miss → +15% bias
 * (matches the RFC §7.3 canonical example).
 */
export function bucketMissToBiasPercent(meanBucketMiss: number): number {
  return Math.round((meanBucketMiss / 4) * 100);
}

function formatBiasPercent(meanBucketMiss: number): string {
  const pct = bucketMissToBiasPercent(meanBucketMiss);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

// ── Per-agent bias stratification (Q2 resolution) ────────────────────────────

/**
 * Bias statistics for a single agent (`predictedBy` field).
 * Q2 resolution: per-agent stratification via `predictedBy`.
 */
export interface AgentBiasStats {
  /** Agent identity (RFC §7.1 `predictedBy` field). */
  predictedBy: string;
  /** Number of sample pairs for this agent. */
  n: number;
  /** Signed mean bucket miss (positive = overestimate). `null` when n = 0. */
  meanBucketMiss: number | null;
  /** Signed median bucket miss. `null` when n = 0. */
  medianBucketMiss: number | null;
  /** The formatted 3-state token for this agent's sample count. */
  stateToken: string;
}

// ── Per-class bias statistics ─────────────────────────────────────────────────

/**
 * Per-class bias statistics returned by `computeBiasStats()`.
 */
export interface ClassBiasStats {
  /** The task class these stats cover. */
  taskClass: TaskClass;
  /** Total sample pairs (across all agents). */
  n: number;
  /** Signed mean bucket miss across all agents (positive = overestimate). `null` when n = 0. */
  meanBucketMiss: number | null;
  /** Signed median bucket miss across all agents. `null` when n = 0. */
  medianBucketMiss: number | null;
  /** The formatted 3-state token for the combined sample count. */
  stateToken: string;
  /** Per-agent breakdown (Q2 resolution). Keyed by `predictedBy` value. */
  byAgent: AgentBiasStats[];
}

export interface ComputeBiasStatsOpts {
  taskClass: TaskClass;
  /** Artifacts directory. Defaults to `ARTIFACTS_DIR` env or `<cwd>/artifacts`. */
  artifactsDir?: string;
}

/**
 * Compute per-class bias statistics from the monthly-rotated calibration files.
 *
 * Returns `n: 0` and null mean/median when there are no calibration records
 * for the class. The state token will be `(uncalibrated)` in that case.
 *
 * Per-agent stratification (Q2 resolution): when multiple `predictedBy` agents
 * appear in the records, each is listed separately in `byAgent`. The combined
 * stats aggregate across all agents.
 */
export function computeBiasStats(opts: ComputeBiasStatsOpts): ClassBiasStats {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const estimatesDir = join(artifactsDir, '_estimates');
  const records = readCalibrationRecords(estimatesDir, opts.taskClass);

  if (records.length === 0) {
    return {
      taskClass: opts.taskClass,
      n: 0,
      meanBucketMiss: null,
      medianBucketMiss: null,
      stateToken: formatStateToken(0),
      byAgent: [],
    };
  }

  // Aggregate all records.
  const allMisses = records.map((r) => r.bucketMiss);
  const meanBucketMiss = mean(allMisses);
  const medianBucketMiss = median(allMisses);
  const n = records.length;

  // Per-agent stratification (Q2 resolution).
  const agentMap = new Map<string, number[]>();
  for (const r of records) {
    const agent = r.predictedBy ?? 'unknown';
    if (!agentMap.has(agent)) agentMap.set(agent, []);
    agentMap.get(agent)!.push(r.bucketMiss);
  }

  const byAgent: AgentBiasStats[] = [];
  for (const [predictedBy, misses] of agentMap.entries()) {
    const agentMean = misses.length > 0 ? mean(misses) : null;
    byAgent.push({
      predictedBy,
      n: misses.length,
      meanBucketMiss: agentMean,
      medianBucketMiss: misses.length > 0 ? median(misses) : null,
      stateToken: formatStateToken(misses.length, agentMean),
    });
  }
  // Sort agents by sample count desc for stable display order.
  byAgent.sort((a, b) => b.n - a.n);

  return {
    taskClass: opts.taskClass,
    n,
    meanBucketMiss,
    medianBucketMiss,
    stateToken: formatStateToken(n, meanBucketMiss),
    byAgent,
  };
}

// ── Stage A vs Stage B accuracy comparison ───────────────────────────────────

/**
 * Stage A vs Stage B accuracy comparison for `cli-estimates show <class>` (AC #1).
 *
 * Joins `logRecords` with `calibrationRecords` by `taskId` and compares:
 *  - **Stage A solo accuracy**: fraction of tasks where `stageA.candidateBucket`
 *    matched `actualBucket` (or was within 1 bucket) — regardless of whether
 *    Stage B ran.
 *  - **Stage B hit rate**: fraction of all log records where Stage B was invoked
 *    (`stageB.invoked === true`). Useful as an operational metric to confirm
 *    Stage B call rate stays below 30% (STAGE_B_CALL_RATE_THRESHOLD).
 *  - **Stage B improvement rate**: among Stage-B-invoked tasks that have a paired
 *    calibration record, the fraction where Stage B's bucket was CLOSER to the
 *    actual bucket than Stage A's `candidateBucket`.
 */
export interface StageAccuracyStats {
  /**
   * Fraction of tasks where Stage A's candidateBucket exactly matched the
   * actual bucket. Computed across all log rows with a calibration record pair.
   * `null` when no paired records exist.
   */
  stageAExactAccuracy: number | null;
  /**
   * Fraction of tasks where Stage A's candidateBucket was within 1 bucket of
   * the actual bucket (exact + 1-bucket miss). More lenient than exact.
   * `null` when no paired records exist.
   */
  stageAWithin1Accuracy: number | null;
  /**
   * Fraction of all log rows where Stage B was invoked (`stageB.invoked === true`).
   * Operational metric — should stay below 30%.
   * `null` when no log rows exist.
   */
  stageBHitRate: number | null;
  /**
   * Among Stage-B-invoked tasks with a paired calibration record, the fraction
   * where Stage B's final bucket was CLOSER to the actual than Stage A's
   * candidateBucket.
   * `null` when no Stage-B-invoked tasks have calibration pairs.
   */
  stageBImprovementRate: number | null;
  /** Number of log rows used in the analysis. */
  totalLogRows: number;
  /** Number of log rows with a paired calibration record. */
  pairedRows: number;
  /** Number of log rows where Stage B was invoked. */
  stageBInvokedRows: number;
}

/**
 * Compute Stage A vs Stage B accuracy comparison for a given task class.
 *
 * Pure function — all data is passed as arguments (no I/O).
 *
 * @param logRecords        All rows from `_estimates/log.jsonl` for the class.
 * @param calibrationRecords All rows from `_estimates/calibration-YYYY-MM.jsonl`
 *                          for the class. Used to look up actual buckets.
 */
export function computeStageAVsStageBAccuracy(
  logRecords: readonly EstimateLogRecord[],
  calibrationRecords: readonly CalibrationRecord[],
): StageAccuracyStats {
  const totalLogRows = logRecords.length;
  if (totalLogRows === 0) {
    return {
      stageAExactAccuracy: null,
      stageAWithin1Accuracy: null,
      stageBHitRate: null,
      stageBImprovementRate: null,
      totalLogRows: 0,
      pairedRows: 0,
      stageBInvokedRows: 0,
    };
  }

  // Build a taskId → actualBucket map from calibration records.
  // When multiple calibration rows exist for the same taskId (shouldn't happen
  // due to the idempotency guard, but be defensive), use the most-recent one.
  const actualBucketMap = new Map<string, Bucket>();
  for (const r of calibrationRecords) {
    actualBucketMap.set(r.taskId, r.actualBucket);
  }

  // Stage B count across ALL log rows.
  const stageBInvokedRows = logRecords.filter((r) => r.stageB?.invoked === true).length;

  // For accuracy stats we need log rows that have a calibration pair.
  const paired = logRecords.filter((r) => actualBucketMap.has(r.taskId));
  const pairedRows = paired.length;

  if (pairedRows === 0) {
    return {
      stageAExactAccuracy: null,
      stageAWithin1Accuracy: null,
      stageBHitRate: totalLogRows > 0 ? stageBInvokedRows / totalLogRows : null,
      stageBImprovementRate: null,
      totalLogRows,
      pairedRows: 0,
      stageBInvokedRows,
    };
  }

  // Stage A accuracy.
  let stageAExactHits = 0;
  let stageAWithin1Hits = 0;
  // Stage B improvement.
  const stageBPaired = paired.filter((r) => r.stageB?.invoked === true);
  let stageBImprovements = 0;

  for (const row of paired) {
    const actual = actualBucketMap.get(row.taskId)!;
    const actualIdx = BUCKET_INDEX[actual];
    const stageAIdx = BUCKET_INDEX[row.stageA.candidateBucket];
    const stageMiss = Math.abs(stageAIdx - actualIdx);

    if (stageMiss === 0) stageAExactHits++;
    if (stageMiss <= 1) stageAWithin1Hits++;
  }

  for (const row of stageBPaired) {
    const actual = actualBucketMap.get(row.taskId)!;
    const actualIdx = BUCKET_INDEX[actual];
    const stageAIdx = BUCKET_INDEX[row.stageA.candidateBucket];

    // Stage B bucket: `stageB.bucket` is the Stage B verdict; `finalBucket`
    // is what was ultimately recorded (may equal Stage B verdict or Stage A
    // if Stage B was skipped but still logged).
    const stageBBucket = row.stageB?.invoked === true ? row.stageB.bucket : undefined;
    if (stageBBucket === undefined) continue;

    const stageBIdx = BUCKET_INDEX[stageBBucket];
    const stageADist = Math.abs(stageAIdx - actualIdx);
    const stageBDist = Math.abs(stageBIdx - actualIdx);

    if (stageBDist < stageADist) stageBImprovements++;
  }

  return {
    stageAExactAccuracy: stageAExactHits / pairedRows,
    stageAWithin1Accuracy: stageAWithin1Hits / pairedRows,
    stageBHitRate: stageBInvokedRows / totalLogRows,
    stageBImprovementRate:
      stageBPaired.length > 0 ? stageBImprovements / stageBPaired.length : null,
    totalLogRows,
    pairedRows,
    stageBInvokedRows,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function resolveArtifactsDir(explicit: string | undefined): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

function readCalibrationRecords(
  estimatesDir: string,
  taskClass: TaskClass,
): (CalibrationRecord & { predictedBy?: string })[] {
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

  const records: (CalibrationRecord & { predictedBy?: string })[] = [];
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
        const r = JSON.parse(line) as CalibrationRecord & { predictedBy?: string };
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

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
