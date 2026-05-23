/**
 * bias-drift tests — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Covers:
 *  - AC #1: `EstimateBiasOverCorrected` event emitted on detection.
 *  - Over-correction detection algorithm (§7.4).
 *  - Insufficient-data guard (no detection when n < threshold).
 *  - Non-triggering cases (no historical bias, mixed recent records).
 *  - Window-signature idempotency contract (alreadyEmitted=true, eventEmitted=false).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectBiasDrift } from './bias-drift.js';
import type { CalibrationRecord } from './calibration-writer.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const SAVED_ENV = { ...process.env };
let tmpDir: string;

function makeTmpArtifacts(): string {
  const dir = join(tmpdir(), `bias-drift-test-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, '_estimates'), { recursive: true });
  return dir;
}

function writeCalibration(artifactsDir: string, records: Partial<CalibrationRecord>[]): void {
  const month = '2026-05';
  const file = join(artifactsDir, '_estimates', `calibration-${month}.jsonl`);
  const lines = records.map((r) =>
    JSON.stringify({
      ts: r.ts ?? '2026-05-01T12:00:00Z',
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

beforeEach(() => {
  tmpDir = makeTmpArtifacts();
  process.env.AI_SDLC_AUTONOMOUS_ORCHESTRATOR = 'experimental';
  process.env.ARTIFACTS_DIR = tmpDir;
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('detectBiasDrift — no data', () => {
  it('returns no over-corrections when no calibration files exist', () => {
    const result = detectBiasDrift({ artifactsDir: tmpDir });
    expect(result.overCorrectedCount).toBe(0);
    expect(result.checks.every((c) => !c.overCorrected)).toBe(true);
    expect(result.checks.every((c) => c.totalRecords === 0)).toBe(true);
  });
});

describe('detectBiasDrift — insufficient data', () => {
  it('does not flag over-correction when n < consecutiveThreshold', () => {
    // Only 2 records for feature class, need >=3
    writeCalibration(tmpDir, [
      { taskId: 'AISDLC-1', class: 'feature', bucketMiss: -1 },
      { taskId: 'AISDLC-2', class: 'feature', bucketMiss: -1 },
    ]);
    const result = detectBiasDrift({ artifactsDir: tmpDir, consecutiveThreshold: 3 });
    const featureCheck = result.checks.find((c) => c.taskClass === 'feature');
    expect(featureCheck?.overCorrected).toBe(false);
    expect(featureCheck?.eventEmitted).toBe(false);
  });
});

describe('detectBiasDrift — AC #1 over-correction detection', () => {
  it('emits EstimateBiasOverCorrected when overall mean > 0 AND last 3 are all <= 0', () => {
    // Historical pattern: 5 overestimates (bucketMiss > 0) then 3 underestimates
    writeCalibration(tmpDir, [
      { taskId: 'AISDLC-1', class: 'feature', bucketMiss: 2, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'AISDLC-2', class: 'feature', bucketMiss: 1, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'AISDLC-3', class: 'feature', bucketMiss: 2, ts: '2026-04-03T10:00:00Z' },
      { taskId: 'AISDLC-4', class: 'feature', bucketMiss: 1, ts: '2026-04-04T10:00:00Z' },
      { taskId: 'AISDLC-5', class: 'feature', bucketMiss: 1, ts: '2026-04-05T10:00:00Z' },
      // Now consistently underestimating
      { taskId: 'AISDLC-6', class: 'feature', bucketMiss: -1, ts: '2026-05-01T10:00:00Z' },
      { taskId: 'AISDLC-7', class: 'feature', bucketMiss: 0, ts: '2026-05-02T10:00:00Z' },
      { taskId: 'AISDLC-8', class: 'feature', bucketMiss: -1, ts: '2026-05-03T10:00:00Z' },
    ]);

    const result = detectBiasDrift({
      artifactsDir: tmpDir,
      taskClass: 'feature',
      consecutiveThreshold: 3,
    });

    const featureCheck = result.checks.find((c) => c.taskClass === 'feature');
    expect(featureCheck?.overCorrected).toBe(true);
    expect(featureCheck?.consecutiveNonPositive).toBe(3);
    expect(featureCheck?.meanMissOverall).toBeGreaterThan(0);
    expect(featureCheck?.meanMissRecent).toBeLessThanOrEqual(0);
    expect(result.overCorrectedCount).toBe(1);
  });

  it('does NOT flag over-correction when no historical positive bias', () => {
    // All records are negative — no historical overestimate to over-correct
    writeCalibration(tmpDir, [
      { taskId: 'AISDLC-1', class: 'bug', bucketMiss: -1, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'AISDLC-2', class: 'bug', bucketMiss: -2, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'AISDLC-3', class: 'bug', bucketMiss: -1, ts: '2026-04-03T10:00:00Z' },
      { taskId: 'AISDLC-4', class: 'bug', bucketMiss: -1, ts: '2026-04-04T10:00:00Z' },
    ]);

    const result = detectBiasDrift({ artifactsDir: tmpDir, taskClass: 'bug' });
    const bugCheck = result.checks.find((c) => c.taskClass === 'bug');
    expect(bugCheck?.overCorrected).toBe(false);
    expect(bugCheck?.eventEmitted).toBe(false);
  });

  it('does NOT flag when recent records break the consecutive pattern', () => {
    // Last 3 records are: -1, +1, -1 — only 1 consecutive at the tail
    writeCalibration(tmpDir, [
      { taskId: 'AISDLC-1', class: 'chore', bucketMiss: 2, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'AISDLC-2', class: 'chore', bucketMiss: 1, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'AISDLC-3', class: 'chore', bucketMiss: 2, ts: '2026-04-03T10:00:00Z' },
      { taskId: 'AISDLC-4', class: 'chore', bucketMiss: -1, ts: '2026-05-01T10:00:00Z' },
      { taskId: 'AISDLC-5', class: 'chore', bucketMiss: 1, ts: '2026-05-02T10:00:00Z' }, // breaks streak
      { taskId: 'AISDLC-6', class: 'chore', bucketMiss: -1, ts: '2026-05-03T10:00:00Z' },
    ]);

    const result = detectBiasDrift({
      artifactsDir: tmpDir,
      taskClass: 'chore',
      consecutiveThreshold: 3,
    });
    const choreCheck = result.checks.find((c) => c.taskClass === 'chore');
    expect(choreCheck?.overCorrected).toBe(false);
    expect(choreCheck?.consecutiveNonPositive).toBe(1); // only the last one
  });

  it('checks all non-uncategorized classes when taskClass is omitted', () => {
    // Only feature has over-correction; bug does not
    writeCalibration(tmpDir, [
      // feature: historical overestimate, recent underestimate (3 records)
      { taskId: 'F1', class: 'feature', bucketMiss: 2, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'F2', class: 'feature', bucketMiss: 1, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'F3', class: 'feature', bucketMiss: 2, ts: '2026-04-03T10:00:00Z' },
      { taskId: 'F4', class: 'feature', bucketMiss: -1, ts: '2026-05-01T10:00:00Z' },
      { taskId: 'F5', class: 'feature', bucketMiss: -1, ts: '2026-05-02T10:00:00Z' },
      { taskId: 'F6', class: 'feature', bucketMiss: -1, ts: '2026-05-03T10:00:00Z' },
      // bug: no over-correction
      { taskId: 'B1', class: 'bug', bucketMiss: 1, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'B2', class: 'bug', bucketMiss: 1, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'B3', class: 'bug', bucketMiss: 1, ts: '2026-04-03T10:00:00Z' },
    ]);

    const result = detectBiasDrift({ artifactsDir: tmpDir });
    expect(result.overCorrectedCount).toBe(1);
    const featureCheck = result.checks.find((c) => c.taskClass === 'feature');
    expect(featureCheck?.overCorrected).toBe(true);
    const bugCheck = result.checks.find((c) => c.taskClass === 'bug');
    expect(bugCheck?.overCorrected).toBe(false);
  });
});

// ── Window-signature idempotency contract ─────────────────────────────────

/**
 * Helper: compute the same windowSignature as bias-drift.ts does internally —
 * SHA-256 of sorted `taskId@ts` tuples of the tail `windowSize` records
 * (already sorted ascending by ts by the caller).
 */
function computeWindowSignature(
  sortedByTs: Array<{ taskId: string; ts: string }>,
  windowSize: number,
): string {
  const tail = sortedByTs.slice(-windowSize);
  const canonical = tail
    .map((r) => `${r.taskId}@${r.ts}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

describe('detectBiasDrift — window-signature idempotency', () => {
  it('returns alreadyEmitted=true and eventEmitted=false when the event was previously emitted for this calibration window', () => {
    // Calibration state: 3 historical overestimates + 3 recent underestimates.
    // This is the identical over-correction pattern used in the AC #1 test.
    const tailRecords = [
      { taskId: 'AISDLC-6', ts: '2026-05-01T10:00:00Z', bucketMiss: -1 },
      { taskId: 'AISDLC-7', ts: '2026-05-02T10:00:00Z', bucketMiss: 0 },
      { taskId: 'AISDLC-8', ts: '2026-05-03T10:00:00Z', bucketMiss: -1 },
    ];

    writeCalibration(tmpDir, [
      { taskId: 'AISDLC-1', class: 'feature', bucketMiss: 2, ts: '2026-04-01T10:00:00Z' },
      { taskId: 'AISDLC-2', class: 'feature', bucketMiss: 1, ts: '2026-04-02T10:00:00Z' },
      { taskId: 'AISDLC-3', class: 'feature', bucketMiss: 2, ts: '2026-04-03T10:00:00Z' },
      { taskId: 'AISDLC-4', class: 'feature', bucketMiss: 1, ts: '2026-04-04T10:00:00Z' },
      { taskId: 'AISDLC-5', class: 'feature', bucketMiss: 1, ts: '2026-04-05T10:00:00Z' },
      ...tailRecords.map((r) => ({ ...r, class: 'feature' as const })),
    ]);

    // Pre-compute the signature that bias-drift.ts will derive for this window.
    // sortedByTs ascending: same order as the tail slice of all 8 records sorted by ts.
    const allSortedByTs = [
      { taskId: 'AISDLC-1', ts: '2026-04-01T10:00:00Z' },
      { taskId: 'AISDLC-2', ts: '2026-04-02T10:00:00Z' },
      { taskId: 'AISDLC-3', ts: '2026-04-03T10:00:00Z' },
      { taskId: 'AISDLC-4', ts: '2026-04-04T10:00:00Z' },
      { taskId: 'AISDLC-5', ts: '2026-04-05T10:00:00Z' },
      ...tailRecords.map((r) => ({ taskId: r.taskId, ts: r.ts })),
    ];
    const windowSignature = computeWindowSignature(allSortedByTs, 3);

    // Seed the events file with a prior EstimateBiasOverCorrected event
    // carrying the same taskClass + windowSignature.
    const orchestratorDir = join(tmpDir, '_orchestrator');
    mkdirSync(orchestratorDir, { recursive: true });
    const eventsFile = join(orchestratorDir, 'events-2026-05-01.jsonl');
    writeFileSync(
      eventsFile,
      JSON.stringify({
        ts: '2026-05-01T10:00:00Z',
        type: 'EstimateBiasOverCorrected',
        taskClass: 'feature',
        consecutiveMisses: 3,
        meanMissOverall: 1.0,
        meanMissRecent: -0.667,
        windowSignature,
      }) + '\n',
      { encoding: 'utf8' },
    );

    // Now call detectBiasDrift with the same calibration state.
    const result = detectBiasDrift({
      artifactsDir: tmpDir,
      taskClass: 'feature',
      consecutiveThreshold: 3,
    });

    const featureCheck = result.checks.find((c) => c.taskClass === 'feature');
    // Over-correction IS detected (the calibration state qualifies).
    expect(featureCheck?.overCorrected).toBe(true);
    // But the event was already emitted — skip re-emission.
    expect(featureCheck?.alreadyEmitted).toBe(true);
    expect(featureCheck?.eventEmitted).toBe(false);
    // The signature must match what we pre-seeded.
    expect(featureCheck?.windowSignature).toBe(windowSignature);
  });
});
