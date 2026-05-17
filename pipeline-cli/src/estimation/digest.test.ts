/**
 * digest tests — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Covers:
 *  - AC #2: Weekly calibration digest generated correctly.
 *  - AC #3: Stage-A-coverage metric computed correctly.
 *  - AC #6: Promotion criteria checked accurately.
 *  - Q6 calibration state token formatter.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  calibrationState,
  formatCalibrationStateToken,
  formatDigestText,
  generateDigest,
  queryStageACoverage,
} from './digest.js';
import type { CalibrationRecord } from './calibration-writer.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const SAVED_ENV = { ...process.env };
let tmpDir: string;

function makeTmpArtifacts(): string {
  const dir = join(tmpdir(), `digest-test-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, '_estimates'), { recursive: true });
  return dir;
}

function writeCalibration(
  artifactsDir: string,
  records: Partial<CalibrationRecord>[],
  month = '2026-05',
): void {
  const file = join(artifactsDir, '_estimates', `calibration-${month}.jsonl`);
  const lines = records.map((r) =>
    JSON.stringify({
      ts: r.ts ?? `2026-${month.slice(5)}-01T12:00:00Z`,
      taskId: r.taskId ?? 'AISDLC-TEST',
      class: r.class ?? 'feature',
      predictedBucket: r.predictedBucket ?? 'M',
      actualBucket: r.actualBucket ?? 'S',
      bucketMiss: r.bucketMiss ?? 1,
      actualWallClockSec: r.actualWallClockSec ?? 900,
      source: 'events.jsonl',
      estimateInputHash: 'sha256:abc',
      runIndex: 1,
      estimateVariance: 0,
    } satisfies CalibrationRecord),
  );
  writeFileSync(file, lines.join('\n') + '\n');
}

function writeLogRows(artifactsDir: string, rows: Partial<EstimateLogRecord>[]): void {
  const file = join(artifactsDir, '_estimates', 'log.jsonl');
  const lines = rows.map((r) =>
    JSON.stringify({
      ts: r.ts ?? '2026-05-01T12:00:00Z',
      predictedBy: r.predictedBy ?? 'stage-a-deterministic',
      taskId: r.taskId ?? 'AISDLC-TEST',
      class: r.class ?? 'feature',
      bucket: r.bucket ?? 'M',
      finalBucket: r.finalBucket ?? 'M',
      stageA: r.stageA ?? {
        signals: [],
        candidateBucket: 'M',
        confidence: 'high',
        escalateToStageB: false,
        rationale: 'test',
      },
      stageB: r.stageB,
      estimateInputHash: r.estimateInputHash ?? 'sha256:abc',
      runIndex: r.runIndex ?? 1,
      context: r.context ?? 'test',
    }),
  );
  writeFileSync(file, lines.join('\n') + '\n');
}

beforeEach(() => {
  tmpDir = makeTmpArtifacts();
  process.env.ARTIFACTS_DIR = tmpDir;
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.env = { ...SAVED_ENV };
});

// ── calibrationState ─────────────────────────────────────────────────────

describe('calibrationState', () => {
  it('returns uncalibrated for n=0', () => expect(calibrationState(0)).toBe('uncalibrated'));
  it('returns warming for 1 ≤ n < 5', () => {
    expect(calibrationState(1)).toBe('warming');
    expect(calibrationState(4)).toBe('warming');
  });
  it('returns calibrated for n ≥ 5', () => {
    expect(calibrationState(5)).toBe('calibrated');
    expect(calibrationState(100)).toBe('calibrated');
  });
});

// ── formatCalibrationStateToken ───────────────────────────────────────────

describe('formatCalibrationStateToken', () => {
  it('formats uncalibrated', () => {
    expect(formatCalibrationStateToken({ state: 'uncalibrated', n: 0 })).toBe('(uncalibrated)');
  });

  it('formats warming with n', () => {
    expect(formatCalibrationStateToken({ state: 'warming', n: 3 })).toBe('(warming, n=3)');
  });

  it('formats calibrated with n and bias', () => {
    expect(formatCalibrationStateToken({ state: 'calibrated', n: 23, meanMiss: 0.15 })).toBe(
      '(calibrated, n=23, bias=+15%)',
    );
  });

  it('appends high-variance qualifier', () => {
    expect(
      formatCalibrationStateToken({
        state: 'calibrated',
        n: 23,
        meanMiss: 0.15,
        highVariance: true,
      }),
    ).toBe('(calibrated, n=23, bias=+15%; high-variance)');
  });

  it('handles negative bias', () => {
    expect(formatCalibrationStateToken({ state: 'calibrated', n: 10, meanMiss: -0.2 })).toBe(
      '(calibrated, n=10, bias=-20%)',
    );
  });
});

// ── generateDigest — empty state ─────────────────────────────────────────

describe('generateDigest — empty', () => {
  it('returns zero counts when no data exists', () => {
    const digest = generateDigest({ artifactsDir: tmpDir });
    expect(digest.totalCalibrationRecords).toBe(0);
    expect(digest.overallStageACoverageRate).toBe(0);
    expect(digest.promotionReadyCount).toBe(0);
    expect(digest.classes).toHaveLength(3); // bug, feature, chore
    expect(digest.classes.every((c) => c.calibrationState === 'uncalibrated')).toBe(true);
  });
});

// ── generateDigest — AC #3 Stage-A-coverage ──────────────────────────────

describe('generateDigest — Stage-A-coverage (AC #3)', () => {
  it('computes coverageRate from log rows — no stageB = 100% Stage-A-only', () => {
    writeLogRows(tmpDir, [
      { class: 'feature', stageB: { invoked: false } },
      { class: 'feature', stageB: { invoked: false } },
      { class: 'feature', stageB: undefined },
    ]);
    const digest = generateDigest({ artifactsDir: tmpDir });
    const featureRow = digest.classes.find((c) => c.taskClass === 'feature')!;
    expect(featureRow.logRows).toBe(3);
    expect(featureRow.stageACoverageRate).toBeCloseTo(1.0);
  });

  it('accounts for Stage B invocations in coverage rate', () => {
    writeLogRows(tmpDir, [
      { class: 'bug', stageB: { invoked: false } },
      { class: 'bug', stageB: { invoked: false } },
      { class: 'bug', stageB: { invoked: true } },
      { class: 'bug', stageB: { invoked: false } },
    ]);
    const digest = generateDigest({ artifactsDir: tmpDir });
    const bugRow = digest.classes.find((c) => c.taskClass === 'bug')!;
    expect(bugRow.logRows).toBe(4);
    expect(bugRow.stageACoverageRate).toBeCloseTo(0.75);
  });
});

// ── generateDigest — calibration stats ───────────────────────────────────

describe('generateDigest — calibration stats', () => {
  it('computes meanBucketMiss and oneBucketMissRate', () => {
    writeCalibration(tmpDir, [
      { class: 'chore', bucketMiss: 1 },
      { class: 'chore', bucketMiss: 0 },
      { class: 'chore', bucketMiss: 1 },
      { class: 'chore', bucketMiss: 2 },
      { class: 'chore', bucketMiss: 0 },
    ]);
    const digest = generateDigest({ artifactsDir: tmpDir });
    const choreRow = digest.classes.find((c) => c.taskClass === 'chore')!;
    expect(choreRow.n).toBe(5);
    expect(choreRow.calibrationState).toBe('calibrated');
    expect(choreRow.meanBucketMiss).toBeCloseTo(0.8);
    // 4 out of 5 have |miss| ≤ 1 (the 2 is excluded)
    expect(choreRow.oneBucketMissRate).toBeCloseTo(0.8);
    expect(choreRow.threeBucketMissRate).toBe(0);
  });
});

// ── generateDigest — AC #6 promotion criteria ────────────────────────────

describe('generateDigest — promotion criteria (AC #6)', () => {
  it('marks promotionReady=true when all 4 criteria are met', () => {
    // 50 records: 48 with |miss|≤1, 2 with |miss|=2, none ≥3; Stage-A-coverage 80%
    const records: Partial<CalibrationRecord>[] = [];
    for (let i = 0; i < 48; i++) {
      records.push({
        taskId: `FEAT-${i}`,
        class: 'feature',
        bucketMiss: i % 2 === 0 ? 1 : 0,
      });
    }
    // 2 with |miss|=2
    records.push({ taskId: 'FEAT-48', class: 'feature', bucketMiss: 2 });
    records.push({ taskId: 'FEAT-49', class: 'feature', bucketMiss: -2 });
    writeCalibration(tmpDir, records);

    // 80% Stage-A coverage: 40 no-stageB, 10 with stageB
    const logRows: Partial<EstimateLogRecord>[] = [];
    for (let i = 0; i < 40; i++) {
      logRows.push({ class: 'feature', stageB: { invoked: false } });
    }
    for (let i = 0; i < 10; i++) {
      logRows.push({ class: 'feature', stageB: { invoked: true } });
    }
    writeLogRows(tmpDir, logRows);

    const digest = generateDigest({ artifactsDir: tmpDir });
    const featureRow = digest.classes.find((c) => c.taskClass === 'feature')!;
    expect(featureRow.n).toBe(50);
    expect(featureRow.oneBucketMissRate).toBeCloseTo(0.96); // 48/50
    expect(featureRow.threeBucketMissRate).toBe(0);
    expect(featureRow.stageACoverageRate).toBeCloseTo(0.8);
    expect(featureRow.promotionReady).toBe(true);
  });

  it('marks promotionReady=false when n < 50', () => {
    const records: Partial<CalibrationRecord>[] = [];
    for (let i = 0; i < 49; i++) {
      records.push({ taskId: `FEAT-${i}`, class: 'feature', bucketMiss: 0 });
    }
    writeCalibration(tmpDir, records);
    const digest = generateDigest({ artifactsDir: tmpDir });
    const featureRow = digest.classes.find((c) => c.taskClass === 'feature')!;
    expect(featureRow.promotionReady).toBe(false);
  });
});

// ── formatDigestText ──────────────────────────────────────────────────────

describe('formatDigestText', () => {
  it('renders a text summary with all required sections', () => {
    const digest = generateDigest({
      artifactsDir: tmpDir,
      now: () => new Date('2026-05-17T10:00:00Z'),
    });
    const text = formatDigestText(digest);
    expect(text).toContain('Estimation Calibration Digest');
    expect(text).toContain('2026-05-17');
    expect(text).toContain('feature');
    expect(text).toContain('Stage-A cov.');
    expect(text).toContain('Promote ready');
  });
});

// ── queryStageACoverage ───────────────────────────────────────────────────

describe('queryStageACoverage', () => {
  it('returns 0 coverage when no log rows exist', () => {
    const result = queryStageACoverage({ artifactsDir: tmpDir });
    expect(result.totalLogRows).toBe(0);
    expect(result.coverageRate).toBe(0);
  });

  it('returns correct coverage for a specific class', () => {
    writeLogRows(tmpDir, [
      { class: 'bug', stageB: { invoked: false } },
      { class: 'bug', stageB: { invoked: true } },
      { class: 'feature', stageB: { invoked: false } }, // excluded
    ]);
    const result = queryStageACoverage({ taskClass: 'bug', artifactsDir: tmpDir });
    expect(result.totalLogRows).toBe(2);
    expect(result.stageAOnlyRows).toBe(1);
    expect(result.coverageRate).toBeCloseTo(0.5);
  });
});
