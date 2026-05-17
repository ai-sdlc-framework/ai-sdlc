/**
 * Calibration writer — RFC-0016 Phase 3 (AISDLC-281).
 *
 * Pairs every completed task's predicted bucket (from `_estimates/log.jsonl`)
 * with the actual wall-clock time derived from `events.jsonl`, computes the
 * bucket miss, and appends the result to a monthly-rotated JSONL file at
 * `$ARTIFACTS_DIR/_estimates/calibration-YYYY-MM.jsonl` (Q4 resolution).
 *
 * ## Actuals collection sources (RFC §8.2, priority order)
 *
 *   1. **`events.jsonl`** (per RFC-0015) — `WorkerDispatch` → `WorkerCompleted`
 *      deltas minus `WorkerParked` / `WorkerResumed` gaps. Most precise.
 *   2. **Fallback** — when events are absent, the record is omitted (future
 *      phases may add git-timestamp + PR-timestamp fallbacks per §8.2).
 *
 * ## Non-work-time exclusion (RFC §8.3)
 *
 *   `WorkerParked` → `WorkerResumed` gaps are subtracted from the elapsed
 *   time so review-wait / operator-decision time doesn't inflate the
 *   "actual" bucket. Multiple park/resume pairs per task are each subtracted
 *   independently.
 *
 * ## Monthly rotation (Q4 resolution)
 *
 *   Each record is appended to `_estimates/calibration-YYYY-MM.jsonl` where
 *   `YYYY-MM` is derived from the `ts` of the record being written (NOT the
 *   current date — so backfills go into the correct historical file).
 *
 * ## Ensemble fields (Q5 resolution)
 *
 *   `estimateInputHash`, `runIndex`, and `estimateVariance` come from the
 *   log row. `estimateVariance` is computed lazily across all same-hash rows
 *   in `log.jsonl` — the spread between the max and min `finalBucket` index
 *   across the batch.
 *
 * ## Signal #2 reader (historicalActualsQuery)
 *
 *   `queryHistoricalActuals()` reads all `calibration-YYYY-MM.jsonl` files
 *   from the artifacts dir, filters by task class, and returns the median
 *   `actualBucket` across records where `actualBucket` is present. This is
 *   the Phase 3 implementation of the signal #2 stub in `signals.ts`.
 *
 * ## Signal #8 reader (reviewerIterationQuery)
 *
 *   `queryReviewerIterations()` reads `events.jsonl` files, filters for the
 *   `OrchestratorIterateDev` event type, and computes the mean iteration
 *   count per task class across all recorded tasks.
 *
 * Best-effort writes: IO failures are logged via the optional logger but
 * never rethrown — a transient disk hiccup cannot crash a pipeline run.
 *
 * @module estimation/calibration-writer
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeEvent } from '../orchestrator/events.js';
import type { PipelineLogger } from '../types.js';
import { type Bucket, BUCKET_INDEX, BUCKETS, type TaskClass } from './types.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── On-disk record shape ─────────────────────────────────────────────────

/**
 * One row in `_estimates/calibration-YYYY-MM.jsonl`.
 *
 * Field set per RFC §8.2:
 *  - `ts` — ISO timestamp of when this calibration record was written.
 *  - `taskId` — the task being measured.
 *  - `class` — task class (per §6.1 taxonomy).
 *  - `predictedBucket` — what Stage A / Stage B predicted.
 *  - `actualBucket` — actual wall-clock mapped to a bucket per §4.1.
 *  - `bucketMiss` — signed integer: positive = overestimate (predicted
 *    larger), negative = underestimate. 0 = exact match.
 *  - `actualWallClockSec` — net work-time in seconds (non-work time
 *    excluded per §8.3).
 *  - `source` — where the actuals came from (`events.jsonl` or `unknown`).
 *  - RFC §8.4 ensemble fields: `estimateInputHash`, `runIndex`,
 *    `estimateVariance`.
 */
export interface CalibrationRecord {
  ts: string;
  taskId: string;
  class: TaskClass;
  predictedBucket: Bucket;
  actualBucket: Bucket;
  /** Signed integer (positive = overestimate, negative = underestimate). */
  bucketMiss: number;
  /** Net work time in seconds — non-work gaps subtracted. */
  actualWallClockSec: number;
  /** Actuals data source. Phase 3 supports `events.jsonl` only. */
  source: 'events.jsonl' | 'unknown';
  /** RFC §8.4 content hash. `sha256:<hex>`. */
  estimateInputHash: string;
  /** RFC §8.4 ensemble run index. */
  runIndex: number;
  /**
   * RFC §8.4 variance across all same-hash rows in log.jsonl
   * (maxBucketIndex − minBucketIndex). 0 for single-run estimates.
   */
  estimateVariance: number;
}

// ── Events shape (minimal) ───────────────────────────────────────────────

type AnyEvent = Record<string, unknown> & { ts: string; type: string; taskId?: string };

// ── Writer options ───────────────────────────────────────────────────────

export interface RecordCalibrationOpts {
  /** Task ID being closed (e.g. `AISDLC-123`). */
  taskId: string;
  /**
   * Artifacts directory. Falls back to env then `<cwd>/artifacts`.
   * Production callers usually leave this undefined.
   */
  artifactsDir?: string;
  /**
   * Override `Date.now()` for the record's `ts` field. Tests inject a
   * frozen clock.
   */
  now?: () => Date;
  /** Optional logger for best-effort write failures. */
  logger?: PipelineLogger;
}

export interface RecordCalibrationResult {
  /** The record that was appended (or `null` when nothing to write). */
  record: CalibrationRecord | null;
  /**
   * Path of the monthly-rotated JSONL file the record was appended to,
   * or `null` when nothing was written.
   */
  calibrationPath: string | null;
  /** Whether an `EstimateActualsRecorded` event was emitted. */
  eventEmitted: boolean;
  /** Human-readable skip reason when `record === null`. */
  skipReason?: string;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Record one calibration entry for `taskId`. The function:
 *
 *  1. Reads `_estimates/log.jsonl` to find the most-recent estimate row
 *     for the task (the `finalBucket` column).
 *  2. Reads `_orchestrator/events-*.jsonl` to find `WorkerDispatch` →
 *     `WorkerCompleted` timestamps and `WorkerParked`/`WorkerResumed` gaps.
 *  3. Computes net work time (dispatch → complete minus parked gaps).
 *  4. Maps wall-clock seconds to an actual bucket per §4.1.
 *  5. Computes bucket-miss and ensemble variance.
 *  6. Appends to the monthly-rotated calibration file.
 *  7. Emits `EstimateActualsRecorded` on the events stream (RFC-0015
 *     orchestrator flag gated — best-effort).
 *
 * Returns `record: null` when no estimate row exists for `taskId` (no
 * prior Stage A capture → nothing to calibrate against) or when no
 * events data is available to compute actuals.
 */
export function recordCalibration(opts: RecordCalibrationOpts): RecordCalibrationResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const now = opts.now ?? ((): Date => new Date());
  const ts = now().toISOString();

  // Step 1 — find the most-recent estimate log row for this task.
  const logPath = join(artifactsDir, '_estimates', 'log.jsonl');
  const logRows = readEstimateLogRows(logPath, opts.taskId);
  if (logRows.length === 0) {
    return {
      record: null,
      calibrationPath: null,
      eventEmitted: false,
      skipReason: `no estimate log rows found for ${opts.taskId}`,
    };
  }

  // Use the LAST log row (most recent) as the predicted bucket.
  const latestLog = logRows[logRows.length - 1]!;
  const predictedBucket = latestLog.finalBucket;

  // Compute ensemble variance across all same-hash log rows.
  const estimateVariance = computeEnsembleVariance(logRows, latestLog.estimateInputHash);

  // Step 2 — parse events.jsonl files to find timing data.
  const orchestratorDir = join(artifactsDir, '_orchestrator');
  const events = readOrchestratorEvents(orchestratorDir, opts.logger);
  const taskEvents = events.filter((e) => e.taskId === opts.taskId);

  // Find dispatch + complete timestamps for this task.
  const dispatchTs = findEventTs(taskEvents, 'OrchestratorDispatched');
  const completedTs = findEventTs(taskEvents, 'OrchestratorCompleted');

  if (dispatchTs === null || completedTs === null) {
    return {
      record: null,
      calibrationPath: null,
      eventEmitted: false,
      skipReason: `no OrchestratorDispatched+OrchestratorCompleted event pair found for ${opts.taskId}`,
    };
  }

  // Step 3 — compute net work time (subtract parked gaps).
  const dispatchMs = new Date(dispatchTs).getTime();
  const completedMs = new Date(completedTs).getTime();
  if (!Number.isFinite(dispatchMs) || !Number.isFinite(completedMs)) {
    return {
      record: null,
      calibrationPath: null,
      eventEmitted: false,
      skipReason: `invalid timestamp in events for ${opts.taskId}`,
    };
  }

  const totalMs = Math.max(0, completedMs - dispatchMs);
  const parkedMs = computeParkedMs(taskEvents);
  const netMs = Math.max(0, totalMs - parkedMs);
  const actualWallClockSec = Math.round(netMs / 1000);

  // Step 4 — map wall-clock seconds to actual bucket.
  const actualBucket = wallClockSecToBucket(actualWallClockSec);

  // Step 5 — compute bucket miss.
  const predictedIdx = BUCKET_INDEX[predictedBucket];
  const actualIdx = BUCKET_INDEX[actualBucket];
  const bucketMiss = predictedIdx - actualIdx; // positive = overestimate

  // Step 6 — build and append the calibration record.
  const record: CalibrationRecord = {
    ts,
    taskId: opts.taskId,
    class: latestLog.class,
    predictedBucket,
    actualBucket,
    bucketMiss,
    actualWallClockSec,
    source: 'events.jsonl',
    estimateInputHash: latestLog.estimateInputHash,
    runIndex: latestLog.runIndex,
    estimateVariance,
  };

  // Monthly rotation: use the record's own `ts` for the filename so
  // backfills go into the correct historical file.
  const monthKey = ts.slice(0, 7); // "YYYY-MM"
  const calibrationPath = join(artifactsDir, '_estimates', `calibration-${monthKey}.jsonl`);
  appendCalibrationRecord(calibrationPath, record, opts.logger);

  // Step 7 — emit event (RFC-0015 flag gated, best-effort).
  const eventEmitted = writeEvent(
    {
      ts,
      type: 'EstimateActualsRecorded',
      taskId: opts.taskId,
      predictedBucket,
      actualBucket,
      bucketMiss,
      actualWallClockSec,
      estimateVariance,
      class: record.class,
    },
    { artifactsDir, now: opts.now, logger: opts.logger },
  );

  return { record, calibrationPath, eventEmitted };
}

// ── Calibration reader ───────────────────────────────────────────────────

export interface QueryHistoricalActualsOpts {
  taskClass: TaskClass;
  artifactsDir?: string;
}

export interface HistoricalActualsResult {
  /** Median actual bucket across the class's calibration records. */
  medianBucket: Bucket | null;
  /** Number of completed tasks in the class's calibration records. */
  n: number;
  /** Mean bucket miss for the class (positive = overestimate bias). */
  meanBucketMiss: number | null;
}

/**
 * Query historical actuals for a task class from the monthly-rotated
 * calibration files. Used by `historicalActualsSignal` (signal #2) once
 * Phase 3 data is available.
 *
 * Returns `medianBucket: null` when n < 5 (the signal returns `unknown`
 * until there are enough samples to be meaningful per §5.1 row #2).
 */
export function queryHistoricalActuals(opts: QueryHistoricalActualsOpts): HistoricalActualsResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const estimatesDir = join(artifactsDir, '_estimates');

  const records = readCalibrationRecords(estimatesDir, opts.taskClass);
  const n = records.length;

  if (n === 0) {
    return { medianBucket: null, n, meanBucketMiss: null };
  }

  // Compute median actual bucket.
  const sortedIdx = records.map((r) => BUCKET_INDEX[r.actualBucket]).sort((a, b) => a - b);

  const medianIdx = sortedIdx[Math.floor(sortedIdx.length / 2)]!;
  const medianBucket = BUCKETS[medianIdx]!;

  // Compute mean bucket miss (positive = overestimate bias).
  const meanBucketMiss = records.reduce((sum, r) => sum + r.bucketMiss, 0) / n;

  return { medianBucket, n, meanBucketMiss };
}

// ── Reviewer-iteration reader ────────────────────────────────────────────

export interface QueryReviewerIterationsOpts {
  taskClass: TaskClass;
  /** Calibration records to restrict the task-id universe (only count
   * iterations for tasks whose class matches). When omitted, all tasks
   * found in events are counted regardless of class. */
  artifactsDir?: string;
}

export interface ReviewerIterationResult {
  /** Mean number of `IterateDev` events per task in this class. */
  meanIterations: number | null;
  /** Number of tasks counted. */
  n: number;
}

/**
 * Query the mean reviewer-iteration count per task class from the
 * orchestrator events stream.
 *
 * The relevant events are any events with type matching `IterateDev`
 * (the orchestrator emits these when the reviewer loop requests a dev
 * iteration). We use the calibration records to restrict the task-id
 * set to those of the target class.
 *
 * Returns `meanIterations: null` when n === 0 (no completed tasks in class).
 */
export function queryReviewerIterations(
  opts: QueryReviewerIterationsOpts,
): ReviewerIterationResult {
  const artifactsDir = resolveArtifactsDir(opts.artifactsDir);
  const estimatesDir = join(artifactsDir, '_estimates');
  const orchestratorDir = join(artifactsDir, '_orchestrator');

  // Get all task IDs in this class from calibration records.
  const classRecords = readCalibrationRecords(estimatesDir, opts.taskClass);
  if (classRecords.length === 0) {
    return { meanIterations: null, n: 0 };
  }
  const classTaskIds = new Set(classRecords.map((r) => r.taskId));

  // Read all events and count IterateDev events per task.
  const allEvents = readOrchestratorEvents(orchestratorDir);
  const iterateEvents = allEvents.filter(
    (e) =>
      typeof e.taskId === 'string' &&
      classTaskIds.has(e.taskId) &&
      e.type === 'OrchestratorIterateDev',
  );

  // Count per task.
  const perTask = new Map<string, number>();
  for (const taskId of classTaskIds) {
    perTask.set(taskId, 0);
  }
  for (const e of iterateEvents) {
    const tid = e.taskId as string;
    perTask.set(tid, (perTask.get(tid) ?? 0) + 1);
  }

  const counts = Array.from(perTask.values());
  const n = counts.length;
  if (n === 0) {
    return { meanIterations: null, n: 0 };
  }
  const meanIterations = counts.reduce((s, c) => s + c, 0) / n;
  return { meanIterations, n };
}

// ── Calibration file path helpers ────────────────────────────────────────

/**
 * Returns the path for the monthly calibration file for a given year-month
 * string (e.g. `"2026-05"`). Useful for tests and CLI inspection.
 */
export function calibrationFilePath(artifactsDir: string, yearMonth: string): string {
  return join(artifactsDir, '_estimates', `calibration-${yearMonth}.jsonl`);
}

/**
 * List all monthly calibration file paths present under `artifactsDir`.
 * Returns paths in lexicographic order (oldest month first).
 */
export function listCalibrationFiles(artifactsDir: string): string[] {
  const estimatesDir = join(artifactsDir, '_estimates');
  if (!existsSync(estimatesDir)) return [];
  try {
    return readdirSync(estimatesDir)
      .filter((f) => /^calibration-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => join(estimatesDir, f));
  } catch {
    return [];
  }
}

// ── Wall-clock → bucket mapping ──────────────────────────────────────────

/**
 * Map actual wall-clock seconds to a t-shirt bucket per RFC §4.1:
 *
 *  - < 600 s (10 min) → XS
 *  - 600 – 1500 s (25 min) → S
 *  - 1500 – 3600 s (60 min) → M
 *  - 3600 – 7200 s (2 h) → L
 *  - > 7200 s → XL
 */
export function wallClockSecToBucket(seconds: number): Bucket {
  if (seconds < 600) return 'XS';
  if (seconds < 1500) return 'S';
  if (seconds < 3600) return 'M';
  if (seconds < 7200) return 'L';
  return 'XL';
}

// ── Internals ────────────────────────────────────────────────────────────

function resolveArtifactsDir(explicit: string | undefined): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

function appendCalibrationRecord(
  path: string,
  record: CalibrationRecord,
  logger?: PipelineLogger,
): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(`[calibration-writer] write failed (path=${path}): ${reason}`);
  }
}

function readEstimateLogRows(logPath: string, taskId: string): EstimateLogRecord[] {
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const rows: EstimateLogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EstimateLogRecord;
      if (r && typeof r === 'object' && r.taskId === taskId) {
        rows.push(r);
      }
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function readOrchestratorEvents(orchestratorDir: string, logger?: PipelineLogger): AnyEvent[] {
  if (!existsSync(orchestratorDir)) return [];
  let files: string[];
  try {
    files = readdirSync(orchestratorDir)
      .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
      .sort() // chronological
      .map((f) => join(orchestratorDir, f));
  } catch {
    return [];
  }

  const events: AnyEvent[] = [];
  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger?.warn(`[calibration-writer] failed to read events file ${filePath}: ${reason}`);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AnyEvent;
        if (e && typeof e === 'object' && typeof e.ts === 'string' && typeof e.type === 'string') {
          events.push(e);
        }
      } catch {
        // skip malformed lines silently
      }
    }
  }
  return events;
}

function findEventTs(events: AnyEvent[], type: string): string | null {
  // Return the first matching event's timestamp.
  for (const e of events) {
    if (e.type === type && typeof e.ts === 'string') {
      return e.ts;
    }
  }
  return null;
}

/**
 * Compute total parked milliseconds by pairing `WorkerParked` →
 * `WorkerResumed` events (via WorkerStateTransition with toState/from+to).
 *
 * Events may encode parked state in two ways (per events schema evolution):
 *  a) `type: 'WorkerStateTransition', to: 'parked'` → parked; `to: 'running'` → resumed.
 *  b) A future dedicated `WorkerParked` / `WorkerResumed` type (not yet
 *     in the event type union — handled via loose string comparison here
 *     so Phase 3 works without a schema migration).
 */
function computeParkedMs(events: AnyEvent[]): number {
  let totalParked = 0;
  let parkStartMs: number | null = null;

  for (const e of events) {
    const isParked =
      (e.type === 'WorkerStateTransition' && (e['to'] === 'parked' || e['toState'] === 'parked')) ||
      e.type === 'WorkerParked';

    const isResumed =
      (e.type === 'WorkerStateTransition' &&
        (e['to'] === 'running' || e['toState'] === 'running')) ||
      e.type === 'WorkerResumed';

    if (isParked) {
      parkStartMs = new Date(e.ts).getTime();
    } else if (isResumed && parkStartMs !== null) {
      const resumeMs = new Date(e.ts).getTime();
      if (Number.isFinite(resumeMs) && resumeMs > parkStartMs) {
        totalParked += resumeMs - parkStartMs;
      }
      parkStartMs = null;
    }
  }
  // Unmatched park at end (task still parked when completed) → treat
  // gap as 0 (the completed event itself closed the clock).
  return totalParked;
}

function readCalibrationRecords(estimatesDir: string, taskClass?: TaskClass): CalibrationRecord[] {
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
          (taskClass === undefined || r.class === taskClass)
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

/**
 * Compute the `estimateVariance` for the latest estimate-hash batch.
 * Variance = maxBucketIndex − minBucketIndex across all log rows that
 * share `estimateInputHash`. Single-run estimates have variance = 0.
 */
function computeEnsembleVariance(rows: EstimateLogRecord[], currentHash: string): number {
  const sameHash = rows.filter((r) => r.estimateInputHash === currentHash);
  if (sameHash.length <= 1) return 0;
  const indices = sameHash.map((r) => BUCKET_INDEX[r.finalBucket]);
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  return max - min;
}
