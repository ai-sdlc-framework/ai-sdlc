/**
 * Bias module tests — RFC-0016 Phase 5 (AISDLC-283).
 *
 * Coverage:
 *  AC #2 — per-agent bias stratification via `predictedBy` field
 *  AC #3 — 3-state token formatter (uncalibrated / warming / calibrated)
 *  AC #1 — Stage A vs Stage B accuracy comparison
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  calibrationStateFor,
  computeBiasStats,
  computeStageAVsStageBAccuracy,
  formatStateToken,
  bucketMissToBiasPercent,
} from './bias.js';
import type { CalibrationRecord } from './calibration-writer.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let workdir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'bias-test-'));
  savedEnv = { ...process.env };
  process.env.ARTIFACTS_DIR = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = savedEnv;
});

function writeCalibrationRow(
  artifactsDir: string,
  row: Partial<CalibrationRecord> & { taskId: string; class: string; bucketMiss: number } & {
    predictedBy?: string;
  },
): void {
  const estimatesDir = join(artifactsDir, '_estimates');
  if (!existsSync(estimatesDir)) mkdirSync(estimatesDir, { recursive: true });
  const ts = row.ts ?? new Date().toISOString();
  const monthKey = ts.slice(0, 7);
  const filePath = join(estimatesDir, `calibration-${monthKey}.jsonl`);
  // Build the record explicitly — spreading `row` at the end would cause
  // TS2783 duplicate-property errors since `row` re-declares `taskId`,
  // `class`, and `bucketMiss`. Instead, merge only the fields that aren't
  // already explicit (actualWallClockSec, source, estimateInputHash, etc.)
  // by placing explicit properties LAST (they win over spread).
  const fullRow: CalibrationRecord & { predictedBy?: string } = {
    ts,
    predictedBucket: 'M',
    actualBucket: 'S',
    actualWallClockSec: 900,
    source: 'events.jsonl',
    estimateInputHash: 'sha256:test',
    runIndex: 1,
    estimateVariance: 0,
    ...row,
    // These must be explicit after the spread so they win over the spread's values.
    taskId: row.taskId,
    class: row.class as never,
    bucketMiss: row.bucketMiss,
    predictedBy: row.predictedBy ?? 'stage-a-deterministic',
  };
  appendFileSync(filePath, JSON.stringify(fullRow) + '\n', 'utf8');
}

// ── 3-state token tests ───────────────────────────────────────────────────────

describe('calibrationStateFor()', () => {
  it('returns uncalibrated for n=0', () => {
    expect(calibrationStateFor(0)).toBe('uncalibrated');
  });

  it('returns warming for 1 ≤ n < 5', () => {
    expect(calibrationStateFor(1)).toBe('warming');
    expect(calibrationStateFor(4)).toBe('warming');
  });

  it('returns calibrated for n ≥ 5', () => {
    expect(calibrationStateFor(5)).toBe('calibrated');
    expect(calibrationStateFor(23)).toBe('calibrated');
  });
});

describe('formatStateToken() — AC #3 3-state token formatter', () => {
  it('uncalibrated: n=0', () => {
    expect(formatStateToken(0)).toBe('(uncalibrated)');
  });

  it('uncalibrated: n=0 with high variance is still uncalibrated', () => {
    expect(formatStateToken(0, null, 3)).toBe('(uncalibrated)');
  });

  it('warming: n=1', () => {
    expect(formatStateToken(1)).toBe('(warming, n=1)');
  });

  it('warming: n=4', () => {
    expect(formatStateToken(4)).toBe('(warming, n=4)');
  });

  it('warming: with high variance appends qualifier', () => {
    expect(formatStateToken(3, null, 2)).toBe('(warming, n=3; high-variance)');
  });

  it('calibrated: n=5 no bias', () => {
    expect(formatStateToken(5)).toBe('(calibrated, n=5)');
  });

  it('calibrated: n=23 with +0.6 mean miss → +15% bias (RFC canonical example)', () => {
    const result = formatStateToken(23, 0.6);
    expect(result).toBe('(calibrated, n=23, bias=+15%)');
  });

  it('calibrated: negative bias (underestimate)', () => {
    const result = formatStateToken(10, -0.6);
    expect(result).toBe('(calibrated, n=10, bias=-15%)');
  });

  it('calibrated: with high variance appends qualifier', () => {
    const result = formatStateToken(23, 0.6, 2);
    expect(result).toBe('(calibrated, n=23, bias=+15%; high-variance)');
  });

  it('calibrated: high variance without bias', () => {
    const result = formatStateToken(10, null, 3);
    expect(result).toBe('(calibrated, n=10; high-variance)');
  });

  it('calibrated: variance=1 does NOT append high-variance', () => {
    const result = formatStateToken(10, null, 1);
    expect(result).toBe('(calibrated, n=10)');
  });
});

describe('bucketMissToBiasPercent()', () => {
  it('+1 bucket miss = +25%', () => {
    expect(bucketMissToBiasPercent(1)).toBe(25);
  });

  it('0.6 bucket miss = +15% (RFC canonical)', () => {
    expect(bucketMissToBiasPercent(0.6)).toBe(15);
  });

  it('-1 bucket miss = -25%', () => {
    expect(bucketMissToBiasPercent(-1)).toBe(-25);
  });
});

// ── computeBiasStats() ────────────────────────────────────────────────────────

describe('computeBiasStats() — AC #2 per-agent stratification', () => {
  it('returns uncalibrated + empty byAgent when no calibration records', () => {
    const result = computeBiasStats({ taskClass: 'feature', artifactsDir: workdir });
    expect(result.n).toBe(0);
    expect(result.meanBucketMiss).toBeNull();
    expect(result.medianBucketMiss).toBeNull();
    expect(result.stateToken).toBe('(uncalibrated)');
    expect(result.byAgent).toHaveLength(0);
  });

  it('returns warming token for 3 samples', () => {
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-1',
      class: 'feature',
      bucketMiss: 1,
      predictedBy: 'stage-a-deterministic',
    });
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-2',
      class: 'feature',
      bucketMiss: 1,
      predictedBy: 'stage-a-deterministic',
    });
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-3',
      class: 'feature',
      bucketMiss: 0,
      predictedBy: 'stage-a-deterministic',
    });

    const result = computeBiasStats({ taskClass: 'feature', artifactsDir: workdir });
    expect(result.n).toBe(3);
    expect(result.stateToken).toMatch(/^[(]warming/);
  });

  it('returns calibrated token for 5+ samples with bias', () => {
    for (let i = 1; i <= 5; i++) {
      writeCalibrationRow(workdir, {
        taskId: `AISDLC-${i}`,
        class: 'feature',
        bucketMiss: 1,
        predictedBy: 'stage-a-deterministic',
      });
    }
    const result = computeBiasStats({ taskClass: 'feature', artifactsDir: workdir });
    expect(result.n).toBe(5);
    expect(result.meanBucketMiss).toBe(1);
    expect(result.medianBucketMiss).toBe(1);
    expect(result.stateToken).toMatch(/calibrated/);
    expect(result.stateToken).toContain('bias=+25%');
  });

  it('stratifies by predictedBy agent — AC #2', () => {
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-1',
      class: 'bug',
      bucketMiss: 2,
      predictedBy: 'claude-opus-4-7',
    });
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-2',
      class: 'bug',
      bucketMiss: 0,
      predictedBy: 'stage-a-deterministic',
    });
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-3',
      class: 'bug',
      bucketMiss: 1,
      predictedBy: 'claude-opus-4-7',
    });

    const result = computeBiasStats({ taskClass: 'bug', artifactsDir: workdir });
    expect(result.n).toBe(3);
    expect(result.byAgent).toHaveLength(2);

    // claude-opus-4-7 has 2 samples (miss 2 + miss 1 → mean 1.5)
    const opusAgent = result.byAgent.find((a) => a.predictedBy === 'claude-opus-4-7');
    expect(opusAgent).toBeDefined();
    expect(opusAgent!.n).toBe(2);
    expect(opusAgent!.meanBucketMiss).toBe(1.5);

    // stage-a-deterministic has 1 sample (miss 0)
    const stageAAgent = result.byAgent.find((a) => a.predictedBy === 'stage-a-deterministic');
    expect(stageAAgent).toBeDefined();
    expect(stageAAgent!.n).toBe(1);
    expect(stageAAgent!.meanBucketMiss).toBe(0);
  });

  it('does not mix bug and feature classes', () => {
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-1',
      class: 'bug',
      bucketMiss: 2,
    });
    writeCalibrationRow(workdir, {
      taskId: 'AISDLC-2',
      class: 'feature',
      bucketMiss: 0,
    });

    const bugResult = computeBiasStats({ taskClass: 'bug', artifactsDir: workdir });
    expect(bugResult.n).toBe(1);
    expect(bugResult.meanBucketMiss).toBe(2);

    const featureResult = computeBiasStats({ taskClass: 'feature', artifactsDir: workdir });
    expect(featureResult.n).toBe(1);
    expect(featureResult.meanBucketMiss).toBe(0);
  });
});

// ── computeStageAVsStageBAccuracy() ───────────────────────────────────────────

describe('computeStageAVsStageBAccuracy() — AC #1 Stage A vs Stage B', () => {
  /** Build a minimal EstimateLogRecord for testing. */
  function makeLogRecord(opts: {
    taskId: string;
    stageACandidateBucket: string;
    stageBInvoked?: boolean;
    stageBBucket?: string;
  }): EstimateLogRecord {
    return {
      ts: new Date().toISOString(),
      predictedBy: 'stage-a-deterministic',
      taskId: opts.taskId,
      class: 'feature',
      bucket: opts.stageACandidateBucket as never,
      finalBucket: opts.stageACandidateBucket as never,
      stageA: {
        signals: [],
        candidateBucket: opts.stageACandidateBucket as never,
        confidence: 'high',
        escalateToStageB: false,
        rationale: 'test',
      },
      ...(opts.stageBInvoked !== undefined
        ? {
            stageB: {
              invoked: opts.stageBInvoked,
              ...(opts.stageBInvoked && opts.stageBBucket
                ? { bucket: opts.stageBBucket as never }
                : {}),
            },
          }
        : {}),
      estimateInputHash: 'sha256:test',
      runIndex: 1,
      classSource: 'heuristic',
      classCached: false,
    } as EstimateLogRecord;
  }

  /** Build a minimal CalibrationRecord for testing. */
  function makeCalibrationRecord(taskId: string, actualBucket: string): CalibrationRecord {
    return {
      ts: new Date().toISOString(),
      taskId,
      class: 'feature',
      predictedBucket: 'M',
      actualBucket: actualBucket as never,
      bucketMiss: 0,
      actualWallClockSec: 900,
      source: 'events.jsonl',
      estimateInputHash: 'sha256:test',
      runIndex: 1,
      estimateVariance: 0,
    };
  }

  it('returns all nulls when no log records', () => {
    const result = computeStageAVsStageBAccuracy([], []);
    expect(result.stageAExactAccuracy).toBeNull();
    expect(result.stageAWithin1Accuracy).toBeNull();
    expect(result.stageBHitRate).toBeNull();
    expect(result.stageBImprovementRate).toBeNull();
    expect(result.totalLogRows).toBe(0);
    expect(result.pairedRows).toBe(0);
  });

  it('returns null accuracy stats when no calibration pairs', () => {
    const logs = [makeLogRecord({ taskId: 'AISDLC-1', stageACandidateBucket: 'S' })];
    const result = computeStageAVsStageBAccuracy(logs, []);
    expect(result.stageAExactAccuracy).toBeNull();
    expect(result.stageBHitRate).toBe(0); // 0 Stage B invocations / 1 total = 0
    expect(result.totalLogRows).toBe(1);
    expect(result.pairedRows).toBe(0);
  });

  it('computes Stage A exact accuracy (1 match out of 2)', () => {
    const logs = [
      makeLogRecord({ taskId: 'AISDLC-1', stageACandidateBucket: 'S' }), // exact match
      makeLogRecord({ taskId: 'AISDLC-2', stageACandidateBucket: 'M' }), // 2-bucket miss (actual XS)
    ];
    const calibration = [
      makeCalibrationRecord('AISDLC-1', 'S'),
      makeCalibrationRecord('AISDLC-2', 'XS'),
    ];
    const result = computeStageAVsStageBAccuracy(logs, calibration);
    expect(result.stageAExactAccuracy).toBe(0.5); // 1/2
    expect(result.stageAWithin1Accuracy).toBe(0.5); // only S→S is within 1; M→XS is 2-bucket miss
    expect(result.pairedRows).toBe(2);
  });

  it('within-1 accuracy includes 1-bucket misses', () => {
    const logs = [
      makeLogRecord({ taskId: 'AISDLC-1', stageACandidateBucket: 'S' }), // exact
      makeLogRecord({ taskId: 'AISDLC-2', stageACandidateBucket: 'M' }), // 1-bucket miss (actual S)
      makeLogRecord({ taskId: 'AISDLC-3', stageACandidateBucket: 'L' }), // 2-bucket miss (actual S)
    ];
    const calibration = [
      makeCalibrationRecord('AISDLC-1', 'S'),
      makeCalibrationRecord('AISDLC-2', 'S'),
      makeCalibrationRecord('AISDLC-3', 'S'),
    ];
    const result = computeStageAVsStageBAccuracy(logs, calibration);
    expect(result.stageAExactAccuracy).toBeCloseTo(1 / 3);
    expect(result.stageAWithin1Accuracy).toBeCloseTo(2 / 3); // S→S and M→S are within 1
  });

  it('computes Stage B hit rate', () => {
    const logs = [
      makeLogRecord({
        taskId: 'AISDLC-1',
        stageACandidateBucket: 'M',
        stageBInvoked: true,
        stageBBucket: 'S',
      }),
      makeLogRecord({ taskId: 'AISDLC-2', stageACandidateBucket: 'S' }),
    ];
    const result = computeStageAVsStageBAccuracy(logs, []);
    expect(result.stageBHitRate).toBe(0.5); // 1/2
    expect(result.stageBInvokedRows).toBe(1);
  });

  it('computes Stage B improvement rate', () => {
    // Stage B was invoked and moved CLOSER to actual
    const logs = [
      makeLogRecord({
        taskId: 'AISDLC-1',
        stageACandidateBucket: 'L',
        stageBInvoked: true,
        stageBBucket: 'M',
      }),
      makeLogRecord({
        taskId: 'AISDLC-2',
        stageACandidateBucket: 'XS',
        stageBInvoked: true,
        stageBBucket: 'XL',
      }),
    ];
    const calibration = [
      makeCalibrationRecord('AISDLC-1', 'M'), // Stage B improved (L→M, actual M)
      makeCalibrationRecord('AISDLC-2', 'M'), // Stage B did not improve (XL is further from M than XS)
    ];
    const result = computeStageAVsStageBAccuracy(logs, calibration);
    expect(result.stageBImprovementRate).toBe(0.5); // 1 of 2 Stage B calls improved
  });
});
