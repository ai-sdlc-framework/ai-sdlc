/**
 * Calibration writer tests — RFC-0016 Phase 3 (AISDLC-281).
 *
 * Coverage:
 *  AC #1 — actuals collector records start/finish per task via events.jsonl.
 *  AC #2 — `calibration-YYYY-MM.jsonl` writer rotates monthly.
 *  AC #3 — non-work-time (WorkerParked → WorkerResumed) excluded from elapsed.
 *  AC #4 — ≥10 completed tasks → paired predicted/actual records present.
 *  AC #5 — signal #2 produces non-`unknown` values once n≥5 per class.
 *  AC #6 — class-default fallback rate drops as calibration data accumulates.
 *
 * Additional coverage:
 *  - wallClockSecToBucket mapping matches RFC §4.1 boundaries.
 *  - Monthly rotation: records written in different months land in separate files.
 *  - Best-effort: missing events → skip (no crash).
 *  - queryHistoricalActuals returns unknown below n=5 threshold.
 *  - queryReviewerIterations counts OrchestratorIterateDev events per class.
 *  - estimateVariance computed correctly across same-hash ensemble rows.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCHESTRATOR_FLAG } from '../orchestrator/feature-flag.js';
import {
  calibrationFilePath,
  listCalibrationFiles,
  queryHistoricalActuals,
  queryReviewerIterations,
  recordCalibration,
  wallClockSecToBucket,
  type CalibrationRecord,
} from './calibration-writer.js';
import { historicalActualsSignal, reviewerIterationSignal } from './signals.js';

// ── Helpers ───────────────────────────────────────────────────────────────

let workdir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'calibration-writer-'));
  savedEnv = { ...process.env };
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = savedEnv;
});

/** Write a minimal estimate log row for a task. */
function writeEstimateLogRow(
  artifactsDir: string,
  opts: {
    taskId: string;
    taskClass?: string;
    finalBucket?: string;
    estimateInputHash?: string;
    runIndex?: number;
  },
): void {
  const estimatesDir = join(artifactsDir, '_estimates');
  if (!existsSync(estimatesDir)) mkdirSync(estimatesDir, { recursive: true });
  const logPath = join(estimatesDir, 'log.jsonl');
  const row = {
    ts: new Date().toISOString(),
    predictedBy: 'stage-a-deterministic',
    taskId: opts.taskId,
    class: opts.taskClass ?? 'feature',
    bucket: opts.finalBucket ?? 'M',
    finalBucket: opts.finalBucket ?? 'M',
    stageA: {
      signals: [],
      candidateBucket: opts.finalBucket ?? 'M',
      confidence: 'high',
      escalateToStageB: false,
      rationale: '',
    },
    estimateInputHash: opts.estimateInputHash ?? 'sha256:abc123',
    runIndex: opts.runIndex ?? 1,
    classSource: 'heuristic',
    classCached: false,
  };
  appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8');
}

/** Write a minimal orchestrator events file with dispatch+complete events. */
function writeEventsFile(
  artifactsDir: string,
  dateStr: string,
  events: Array<Record<string, unknown>>,
): void {
  const dir = join(artifactsDir, '_orchestrator');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `events-${dateStr}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(filePath, lines, 'utf8');
}

/** Write a calibration record directly (for seeding queryHistoricalActuals). */
function writeCalibrationRecord(
  artifactsDir: string,
  record: Partial<CalibrationRecord> & {
    taskId: string;
    class: string;
    actualBucket: string;
    predictedBucket: string;
  },
): void {
  const monthKey = (record.ts ?? new Date().toISOString()).slice(0, 7);
  const filePath = calibrationFilePath(artifactsDir, monthKey);
  const dir = join(artifactsDir, '_estimates');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const row: CalibrationRecord = {
    ts: record.ts ?? new Date().toISOString(),
    taskId: record.taskId,
    class: record.class as CalibrationRecord['class'],
    predictedBucket: record.predictedBucket as CalibrationRecord['predictedBucket'],
    actualBucket: record.actualBucket as CalibrationRecord['actualBucket'],
    bucketMiss: record.bucketMiss ?? 0,
    actualWallClockSec: record.actualWallClockSec ?? 600,
    source: 'events.jsonl',
    estimateInputHash: record.estimateInputHash ?? 'sha256:abc',
    runIndex: record.runIndex ?? 1,
    estimateVariance: record.estimateVariance ?? 0,
  };
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

// ── wallClockSecToBucket ───────────────────────────────────────────────────

describe('wallClockSecToBucket', () => {
  it('maps 0s → XS (below 10 min)', () => {
    expect(wallClockSecToBucket(0)).toBe('XS');
  });
  it('maps 599s → XS (just under 10 min)', () => {
    expect(wallClockSecToBucket(599)).toBe('XS');
  });
  it('maps 600s → S (exactly 10 min)', () => {
    expect(wallClockSecToBucket(600)).toBe('S');
  });
  it('maps 1499s → S (just under 25 min)', () => {
    expect(wallClockSecToBucket(1499)).toBe('S');
  });
  it('maps 1500s → M (exactly 25 min)', () => {
    expect(wallClockSecToBucket(1500)).toBe('M');
  });
  it('maps 3599s → M (just under 60 min)', () => {
    expect(wallClockSecToBucket(3599)).toBe('M');
  });
  it('maps 3600s → L (exactly 60 min)', () => {
    expect(wallClockSecToBucket(3600)).toBe('L');
  });
  it('maps 7199s → L (just under 2h)', () => {
    expect(wallClockSecToBucket(7199)).toBe('L');
  });
  it('maps 7200s → XL (exactly 2h)', () => {
    expect(wallClockSecToBucket(7200)).toBe('XL');
  });
  it('maps 10000s → XL (over 2h)', () => {
    expect(wallClockSecToBucket(10000)).toBe('XL');
  });
});

// ── recordCalibration — basic write ───────────────────────────────────────

describe('recordCalibration — basic write (AC #1, AC #2)', () => {
  it('returns null when no estimate log row exists for the task', () => {
    const result = recordCalibration({ taskId: 'AISDLC-999', artifactsDir: workdir });
    expect(result.record).toBeNull();
    expect(result.skipReason).toMatch(/no estimate log rows/);
  });

  it('returns null when events have no dispatch/complete pair', () => {
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-1' });
    // No events file written.
    const result = recordCalibration({ taskId: 'AISDLC-1', artifactsDir: workdir });
    expect(result.record).toBeNull();
    expect(result.skipReason).toMatch(/OrchestratorDispatched\+OrchestratorCompleted/);
  });

  it('writes a calibration record with all required fields (AC #1)', () => {
    writeEstimateLogRow(workdir, {
      taskId: 'AISDLC-100',
      taskClass: 'feature',
      finalBucket: 'M',
      estimateInputHash: 'sha256:deadbeef',
      runIndex: 1,
    });

    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-100' },
      { ts: '2026-05-01T11:00:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-100' },
    ]);

    const now = () => new Date('2026-05-01T11:00:00Z');
    const result = recordCalibration({ taskId: 'AISDLC-100', artifactsDir: workdir, now });

    expect(result.record).not.toBeNull();
    const r = result.record!;
    expect(r.taskId).toBe('AISDLC-100');
    expect(r.class).toBe('feature');
    expect(r.predictedBucket).toBe('M');
    // dispatch=10:00, complete=11:00 → 3600s → L bucket (≥3600 and <7200)
    expect(r.actualBucket).toBe('L');
    expect(r.bucketMiss).toBe(-1); // predicted M (2), actual L (3) → miss = 2-3 = -1
    expect(r.actualWallClockSec).toBe(3600);
    expect(r.source).toBe('events.jsonl');
    expect(r.estimateInputHash).toBe('sha256:deadbeef');
    expect(r.runIndex).toBe(1);
    expect(r.estimateVariance).toBe(0);
  });

  it('appends to the monthly-rotated file, not a fixed path (AC #2)', () => {
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-200', taskClass: 'bug', finalBucket: 'S' });
    writeEventsFile(workdir, '2026-06-15', [
      { ts: '2026-06-15T09:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-200' },
      { ts: '2026-06-15T09:10:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-200' }, // 600s → S
    ]);

    const now = () => new Date('2026-06-15T09:10:00Z');
    const result = recordCalibration({ taskId: 'AISDLC-200', artifactsDir: workdir, now });

    expect(result.calibrationPath).toBe(calibrationFilePath(workdir, '2026-06'));
    expect(existsSync(result.calibrationPath!)).toBe(true);

    const rows = readFileSync(result.calibrationPath!, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CalibrationRecord);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe('AISDLC-200');
  });

  it('records go into different monthly files by their ts (AC #2)', () => {
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-MAY', taskClass: 'bug', finalBucket: 'XS' });
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-JUN', taskClass: 'bug', finalBucket: 'XS' });

    writeEventsFile(workdir, '2026-05-10', [
      { ts: '2026-05-10T08:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-MAY' },
      { ts: '2026-05-10T08:05:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-MAY' },
    ]);
    writeEventsFile(workdir, '2026-06-10', [
      { ts: '2026-06-10T08:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-JUN' },
      { ts: '2026-06-10T08:05:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-JUN' },
    ]);

    recordCalibration({
      taskId: 'AISDLC-MAY',
      artifactsDir: workdir,
      now: () => new Date('2026-05-10T08:05:00Z'),
    });
    recordCalibration({
      taskId: 'AISDLC-JUN',
      artifactsDir: workdir,
      now: () => new Date('2026-06-10T08:05:00Z'),
    });

    const files = listCalibrationFiles(workdir);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('calibration-2026-05.jsonl');
    expect(files[1]).toContain('calibration-2026-06.jsonl');
  });
});

// ── Non-work-time exclusion (AC #3) ───────────────────────────────────────

describe('recordCalibration — non-work-time exclusion (AC #3)', () => {
  it('subtracts WorkerParked → WorkerResumed gaps from elapsed time', () => {
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-PARK', taskClass: 'feature', finalBucket: 'L' });

    // Dispatch at 10:00; parked 10:10→10:30 (20 min gap); completed 11:00
    // Total elapsed: 60 min; parked: 20 min; net: 40 min = 2400s → M
    writeEventsFile(workdir, '2026-05-02', [
      { ts: '2026-05-02T10:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-PARK' },
      {
        ts: '2026-05-02T10:10:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-PARK',
        to: 'parked',
      },
      {
        ts: '2026-05-02T10:30:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-PARK',
        to: 'running',
      },
      { ts: '2026-05-02T11:00:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-PARK' },
    ]);

    const result = recordCalibration({
      taskId: 'AISDLC-PARK',
      artifactsDir: workdir,
      now: () => new Date('2026-05-02T11:00:00Z'),
    });

    expect(result.record).not.toBeNull();
    expect(result.record!.actualWallClockSec).toBe(2400); // 60 - 20 min = 40 min = 2400s
    expect(result.record!.actualBucket).toBe('M'); // 2400s is in 1500-3600 range → M
  });

  it('handles multiple park/resume pairs correctly', () => {
    writeEstimateLogRow(workdir, {
      taskId: 'AISDLC-MULTIPARK',
      taskClass: 'feature',
      finalBucket: 'XL',
    });

    // Dispatch 10:00; park 10:10→10:20 (10 min); park 10:40→11:00 (20 min); complete 12:00
    // Total: 120 min; parked: 30 min; net: 90 min = 5400s → L
    writeEventsFile(workdir, '2026-05-03', [
      { ts: '2026-05-03T10:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-MULTIPARK' },
      {
        ts: '2026-05-03T10:10:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-MULTIPARK',
        to: 'parked',
      },
      {
        ts: '2026-05-03T10:20:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-MULTIPARK',
        to: 'running',
      },
      {
        ts: '2026-05-03T10:40:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-MULTIPARK',
        to: 'parked',
      },
      {
        ts: '2026-05-03T11:00:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-MULTIPARK',
        to: 'running',
      },
      { ts: '2026-05-03T12:00:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-MULTIPARK' },
    ]);

    const result = recordCalibration({
      taskId: 'AISDLC-MULTIPARK',
      artifactsDir: workdir,
      now: () => new Date('2026-05-03T12:00:00Z'),
    });

    expect(result.record).not.toBeNull();
    expect(result.record!.actualWallClockSec).toBe(5400); // 120 - 30 = 90 min = 5400s
    expect(result.record!.actualBucket).toBe('L'); // 5400s is in 3600-7200 → L
  });

  it('handles events where toState is used instead of to', () => {
    writeEstimateLogRow(workdir, { taskId: 'AISDLC-TOSTATE', taskClass: 'bug', finalBucket: 'S' });
    writeEventsFile(workdir, '2026-05-04', [
      { ts: '2026-05-04T09:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-TOSTATE' },
      {
        ts: '2026-05-04T09:05:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-TOSTATE',
        toState: 'parked',
      },
      {
        ts: '2026-05-04T09:10:00Z',
        type: 'WorkerStateTransition',
        taskId: 'AISDLC-TOSTATE',
        toState: 'running',
      },
      { ts: '2026-05-04T09:20:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-TOSTATE' }, // 20min total - 5min park = 15min = 900s → S
    ]);

    const result = recordCalibration({
      taskId: 'AISDLC-TOSTATE',
      artifactsDir: workdir,
      now: () => new Date('2026-05-04T09:20:00Z'),
    });

    expect(result.record).not.toBeNull();
    expect(result.record!.actualWallClockSec).toBe(900); // 20-5 = 15 min = 900s
    expect(result.record!.actualBucket).toBe('S'); // 900s in 600-1499 → S
  });
});

// ── AC #4: ≥10 completed tasks → paired records present ───────────────────

describe('recordCalibration — AC #4 (≥10 paired records)', () => {
  it('produces 10 calibration records for 10 completed tasks', () => {
    for (let i = 1; i <= 10; i += 1) {
      const taskId = `AISDLC-BATCH-${i}`;
      writeEstimateLogRow(workdir, { taskId, taskClass: 'feature', finalBucket: 'M' });
      writeEventsFile(workdir, `2026-05-${String(i).padStart(2, '0')}`, [
        {
          ts: `2026-05-${String(i).padStart(2, '0')}T10:00:00Z`,
          type: 'OrchestratorDispatched',
          taskId,
        },
        {
          ts: `2026-05-${String(i).padStart(2, '0')}T11:00:00Z`,
          type: 'OrchestratorCompleted',
          taskId,
        },
      ]);
    }

    for (let i = 1; i <= 10; i += 1) {
      const taskId = `AISDLC-BATCH-${i}`;
      const day = String(i).padStart(2, '0');
      const result = recordCalibration({
        taskId,
        artifactsDir: workdir,
        now: () => new Date(`2026-05-${day}T11:00:00Z`),
      });
      expect(result.record).not.toBeNull();
      expect(result.record!.predictedBucket).toBe('M');
      expect(typeof result.record!.actualBucket).toBe('string');
    }

    // All 10 records in the May file.
    const mayPath = calibrationFilePath(workdir, '2026-05');
    expect(existsSync(mayPath)).toBe(true);
    const rows = readFileSync(mayPath, 'utf8').split('\n').filter(Boolean);
    expect(rows).toHaveLength(10);
  });
});

// ── queryHistoricalActuals (AC #5) ────────────────────────────────────────

describe('queryHistoricalActuals (AC #5)', () => {
  it('returns medianBucket: null when no records exist', () => {
    const r = queryHistoricalActuals({ taskClass: 'feature', artifactsDir: workdir });
    expect(r.medianBucket).toBeNull();
    expect(r.n).toBe(0);
  });

  it('returns the raw median even when n < 5 (threshold enforcement is in the signal)', () => {
    for (let i = 0; i < 4; i += 1) {
      writeCalibrationRecord(workdir, {
        taskId: `AISDLC-${i}`,
        class: 'feature',
        predictedBucket: 'M',
        actualBucket: 'S',
        bucketMiss: 1,
      });
    }
    const r = queryHistoricalActuals({ taskClass: 'feature', artifactsDir: workdir });
    // Raw query returns data at any n; signal #2 applies the n≥5 threshold
    expect(r.n).toBe(4);
    expect(r.medianBucket).toBe('S'); // 4 × S → median is S
  });

  it('returns non-null medianBucket once n≥5 (AC #5)', () => {
    // 5 records: 3 × S, 1 × M, 1 × L → median index = S (1) at position 2/5
    const actuals = ['S', 'S', 'S', 'M', 'L'] as const;
    actuals.forEach((bucket, i) => {
      writeCalibrationRecord(workdir, {
        taskId: `AISDLC-${i}`,
        class: 'feature',
        predictedBucket: 'M',
        actualBucket: bucket,
        bucketMiss: 0,
      });
    });

    const r = queryHistoricalActuals({ taskClass: 'feature', artifactsDir: workdir });
    expect(r.medianBucket).not.toBeNull();
    expect(r.n).toBe(5);
    // Sorted indices: [1,1,1,2,3] → median at index 2 → S (1)
    expect(r.medianBucket).toBe('S');
  });

  it('only counts records matching the requested class', () => {
    writeCalibrationRecord(workdir, {
      taskId: 'BUG-1',
      class: 'bug',
      predictedBucket: 'S',
      actualBucket: 'XS',
      bucketMiss: 1,
    });
    writeCalibrationRecord(workdir, {
      taskId: 'BUG-2',
      class: 'bug',
      predictedBucket: 'S',
      actualBucket: 'S',
      bucketMiss: 0,
    });
    for (let i = 0; i < 5; i += 1) {
      writeCalibrationRecord(workdir, {
        taskId: `FEAT-${i}`,
        class: 'feature',
        predictedBucket: 'L',
        actualBucket: 'L',
        bucketMiss: 0,
      });
    }

    const bugResult = queryHistoricalActuals({ taskClass: 'bug', artifactsDir: workdir });
    expect(bugResult.n).toBe(2);
    // Raw query returns the median at any n; signal #2 applies the n≥5 threshold
    // BUG-1: XS(0), BUG-2: S(1) → sorted [0,1] → median at floor(2/2)=1 → S(1)
    expect(bugResult.medianBucket).toBe('S');

    const featResult = queryHistoricalActuals({ taskClass: 'feature', artifactsDir: workdir });
    expect(featResult.n).toBe(5);
    expect(featResult.medianBucket).toBe('L');
  });

  it('reads records across multiple monthly files', () => {
    // 3 records in May, 2 in June → total 5 → n≥5 threshold met
    for (let i = 0; i < 3; i += 1) {
      writeCalibrationRecord(workdir, {
        ts: `2026-05-0${i + 1}T10:00:00Z`,
        taskId: `MAY-${i}`,
        class: 'chore',
        predictedBucket: 'S',
        actualBucket: 'XS',
        bucketMiss: 1,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      writeCalibrationRecord(workdir, {
        ts: `2026-06-0${i + 1}T10:00:00Z`,
        taskId: `JUN-${i}`,
        class: 'chore',
        predictedBucket: 'S',
        actualBucket: 'XS',
        bucketMiss: 1,
      });
    }

    const r = queryHistoricalActuals({ taskClass: 'chore', artifactsDir: workdir });
    expect(r.n).toBe(5);
    expect(r.medianBucket).toBe('XS');
  });
});

// ── historicalActualsSignal (signal #2) ───────────────────────────────────

describe('historicalActualsSignal (signal #2)', () => {
  it('returns unknown when no calibration data exists', () => {
    const out = historicalActualsSignal({ taskClass: 'feature', artifactsDir: workdir });
    expect(out.id).toBe(2);
    expect(out.result.kind).toBe('unknown');
  });

  it('returns unknown when n < 5', () => {
    for (let i = 0; i < 4; i += 1) {
      writeCalibrationRecord(workdir, {
        taskId: `T-${i}`,
        class: 'feature',
        predictedBucket: 'M',
        actualBucket: 'S',
        bucketMiss: 1,
      });
    }
    const out = historicalActualsSignal({ taskClass: 'feature', artifactsDir: workdir });
    expect(out.result.kind).toBe('unknown');
  });

  it('returns a bucket once n≥5 (AC #5)', () => {
    for (let i = 0; i < 5; i += 1) {
      writeCalibrationRecord(workdir, {
        taskId: `T-${i}`,
        class: 'feature',
        predictedBucket: 'M',
        actualBucket: 'S',
        bucketMiss: 1,
      });
    }
    const out = historicalActualsSignal({ taskClass: 'feature', artifactsDir: workdir });
    expect(out.id).toBe(2);
    expect(out.result.kind).toBe('bucket');
    if (out.result.kind === 'bucket') {
      expect(out.result.bucket).toBe('S');
    }
  });
});

// ── queryReviewerIterations ────────────────────────────────────────────────

describe('queryReviewerIterations', () => {
  it('returns n=0 when no calibration records exist', () => {
    const r = queryReviewerIterations({ taskClass: 'feature', artifactsDir: workdir });
    expect(r.n).toBe(0);
    expect(r.meanIterations).toBeNull();
  });

  it('returns meanIterations=0 when tasks exist but no IterateDev events', () => {
    writeCalibrationRecord(workdir, {
      taskId: 'FEAT-1',
      class: 'feature',
      predictedBucket: 'M',
      actualBucket: 'M',
      bucketMiss: 0,
    });
    // No IterateDev events written.
    const r = queryReviewerIterations({ taskClass: 'feature', artifactsDir: workdir });
    expect(r.n).toBe(1);
    expect(r.meanIterations).toBe(0);
  });

  it('counts OrchestratorIterateDev events per task in the class', () => {
    // Seed 2 feature tasks in calibration.
    writeCalibrationRecord(workdir, {
      taskId: 'FEAT-A',
      class: 'feature',
      predictedBucket: 'M',
      actualBucket: 'L',
      bucketMiss: -1,
    });
    writeCalibrationRecord(workdir, {
      taskId: 'FEAT-B',
      class: 'feature',
      predictedBucket: 'S',
      actualBucket: 'S',
      bucketMiss: 0,
    });

    // FEAT-A had 2 iterations, FEAT-B had 0.
    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorIterateDev', taskId: 'FEAT-A' },
      { ts: '2026-05-01T10:30:00Z', type: 'OrchestratorIterateDev', taskId: 'FEAT-A' },
      // FEAT-B events but different type (not iteration)
      { ts: '2026-05-01T11:00:00Z', type: 'OrchestratorCompleted', taskId: 'FEAT-B' },
    ]);

    const r = queryReviewerIterations({ taskClass: 'feature', artifactsDir: workdir });
    expect(r.n).toBe(2);
    expect(r.meanIterations).toBe(1); // (2+0)/2 = 1.0
  });

  it('does not count iteration events from other classes', () => {
    writeCalibrationRecord(workdir, {
      taskId: 'BUG-A',
      class: 'bug',
      predictedBucket: 'S',
      actualBucket: 'S',
      bucketMiss: 0,
    });
    writeCalibrationRecord(workdir, {
      taskId: 'FEAT-A',
      class: 'feature',
      predictedBucket: 'M',
      actualBucket: 'M',
      bucketMiss: 0,
    });

    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-A' },
      { ts: '2026-05-01T10:30:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-A' },
    ]);

    // Only querying feature class — FEAT-A has 0 iteration events.
    const featResult = queryReviewerIterations({ taskClass: 'feature', artifactsDir: workdir });
    expect(featResult.n).toBe(1);
    expect(featResult.meanIterations).toBe(0);

    // Querying bug class — BUG-A has 2 iteration events.
    const bugResult = queryReviewerIterations({ taskClass: 'bug', artifactsDir: workdir });
    expect(bugResult.n).toBe(1);
    expect(bugResult.meanIterations).toBe(2);
  });
});

// ── reviewerIterationSignal (signal #8) ───────────────────────────────────

describe('reviewerIterationSignal (signal #8)', () => {
  it('returns unknown when no calibration data for class exists', () => {
    const out = reviewerIterationSignal({ taskClass: 'feature', artifactsDir: workdir });
    expect(out.id).toBe(8);
    expect(out.result.kind).toBe('unknown');
  });

  it('returns bump 0 when mean iterations ≤ 1.0', () => {
    writeCalibrationRecord(workdir, {
      taskId: 'FEAT-A',
      class: 'feature',
      predictedBucket: 'M',
      actualBucket: 'M',
      bucketMiss: 0,
    });
    // No iteration events → mean = 0 → bump 0.
    const out = reviewerIterationSignal({ taskClass: 'feature', artifactsDir: workdir });
    expect(out.result.kind).toBe('bump');
    if (out.result.kind === 'bump') {
      expect(out.result.delta).toBe(0);
    }
  });

  it('returns bump +1 when mean iterations > 1.0', () => {
    writeCalibrationRecord(workdir, {
      taskId: 'BUG-A',
      class: 'bug',
      predictedBucket: 'S',
      actualBucket: 'S',
      bucketMiss: 0,
    });
    writeCalibrationRecord(workdir, {
      taskId: 'BUG-B',
      class: 'bug',
      predictedBucket: 'S',
      actualBucket: 'M',
      bucketMiss: -1,
    });

    // BUG-A: 3 iterations; BUG-B: 1 iteration → mean = 2.0 > 1.0 → +1 bump
    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-A' },
      { ts: '2026-05-01T10:30:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-A' },
      { ts: '2026-05-01T11:00:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-A' },
      { ts: '2026-05-01T12:00:00Z', type: 'OrchestratorIterateDev', taskId: 'BUG-B' },
    ]);

    const out = reviewerIterationSignal({ taskClass: 'bug', artifactsDir: workdir });
    expect(out.result.kind).toBe('bump');
    if (out.result.kind === 'bump') {
      expect(out.result.delta).toBe(1);
    }
  });
});

// ── AC #6: class-default fallback rate drops ───────────────────────────────

describe('AC #6 — class-default fallback rate drops with calibration data', () => {
  it('signal #2 returns unknown before n=5, bucket after (metric exposed)', () => {
    // Before: signal #2 returns unknown → fallback fires
    const before = historicalActualsSignal({ taskClass: 'chore', artifactsDir: workdir });
    expect(before.result.kind).toBe('unknown');

    // Seed 5 chore records
    for (let i = 0; i < 5; i += 1) {
      writeCalibrationRecord(workdir, {
        taskId: `CHORE-${i}`,
        class: 'chore',
        predictedBucket: 'S',
        actualBucket: 'XS',
        bucketMiss: 1,
      });
    }

    // After: signal #2 returns a bucket → class-default fallback retires
    const after = historicalActualsSignal({ taskClass: 'chore', artifactsDir: workdir });
    expect(after.result.kind).toBe('bucket');
    // The median actual bucket (5 × XS) is XS
    if (after.result.kind === 'bucket') {
      expect(after.result.bucket).toBe('XS');
    }
  });
});

// ── estimateVariance ───────────────────────────────────────────────────────

describe('recordCalibration — estimateVariance (AC ensemble, Q5)', () => {
  it('computes estimateVariance=0 for a single log row', () => {
    writeEstimateLogRow(workdir, {
      taskId: 'AISDLC-VAR',
      taskClass: 'feature',
      finalBucket: 'M',
      estimateInputHash: 'sha256:solo',
      runIndex: 1,
    });
    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-VAR' },
      { ts: '2026-05-01T10:30:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-VAR' },
    ]);

    const result = recordCalibration({
      taskId: 'AISDLC-VAR',
      artifactsDir: workdir,
      now: () => new Date('2026-05-01T10:30:00Z'),
    });
    expect(result.record!.estimateVariance).toBe(0);
  });

  it('computes estimateVariance across same-hash ensemble rows', () => {
    // 3 rows for same task: same hash, buckets XS(0) / M(2) / L(3) → variance = 3
    const hash = 'sha256:ensemble123';
    const buckets = ['XS', 'M', 'L'] as const;
    buckets.forEach((bucket, i) => {
      writeEstimateLogRow(workdir, {
        taskId: 'AISDLC-ENS',
        taskClass: 'feature',
        finalBucket: bucket,
        estimateInputHash: hash,
        runIndex: i + 1,
      });
    });

    writeEventsFile(workdir, '2026-05-01', [
      { ts: '2026-05-01T10:00:00Z', type: 'OrchestratorDispatched', taskId: 'AISDLC-ENS' },
      { ts: '2026-05-01T12:00:00Z', type: 'OrchestratorCompleted', taskId: 'AISDLC-ENS' },
    ]);

    const result = recordCalibration({
      taskId: 'AISDLC-ENS',
      artifactsDir: workdir,
      now: () => new Date('2026-05-01T12:00:00Z'),
    });
    // variance: max(0,2,3) - min(0,2,3) = 3 - 0 = 3
    expect(result.record!.estimateVariance).toBe(3);
  });
});
