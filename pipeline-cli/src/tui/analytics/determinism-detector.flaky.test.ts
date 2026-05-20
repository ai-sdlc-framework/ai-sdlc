/**
 * Tests for RFC-0025 OQ-7 determinism-violation detection.
 * SUBSTRATE (AISDLC-302 Phase 1 / salvaged from PR #481).
 *
 * NOTE: shouldSampleDeterminism() uses flat 1-in-50 sampling.
 * Phase 5 (AISDLC-306 / OQ-7) adds risk-based blast-radius composition.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkDeterminismViolation,
  recordDeterminismBaseline,
  readDeterminismBaseline,
  shouldSampleDeterminism,
  DETERMINISM_SAMPLE_RATE,
  type DeterminismBaseline,
} from './determinism-detector.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'determinism-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const BASELINE: DeterminismBaseline = {
  taskId: 'AISDLC-123',
  ts: '2026-05-13T00:00:00.000Z',
  dispatchCount: 50,
  filesChanged: ['pipeline-cli/src/foo.ts', 'pipeline-cli/src/bar.ts'],
  commitSubject: 'feat: add foo bar (AISDLC-123)',
  requiresDeterminism: false,
};

// ── Sampling logic ────────────────────────────────────────────────────

describe('shouldSampleDeterminism', () => {
  it(`samples on every ${DETERMINISM_SAMPLE_RATE}th dispatch`, () => {
    expect(shouldSampleDeterminism(50, false)).toBe(true);
    expect(shouldSampleDeterminism(100, false)).toBe(true);
    expect(shouldSampleDeterminism(150, false)).toBe(true);
  });

  it('does NOT sample on non-multiples of 50', () => {
    expect(shouldSampleDeterminism(1, false)).toBe(false);
    expect(shouldSampleDeterminism(49, false)).toBe(false);
    expect(shouldSampleDeterminism(51, false)).toBe(false);
  });

  it('always samples when requiresDeterminism is true', () => {
    for (let i = 1; i <= 100; i++) {
      expect(shouldSampleDeterminism(i, true)).toBe(true);
    }
  });
});

// ── Baseline storage ──────────────────────────────────────────────────

describe('recordDeterminismBaseline + readDeterminismBaseline', () => {
  it('round-trips a baseline through disk', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const loaded = readDeterminismBaseline(BASELINE.taskId, { artifactsDir: workdir });
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe(BASELINE.taskId);
    expect(loaded?.filesChanged).toEqual(BASELINE.filesChanged);
    expect(loaded?.commitSubject).toBe(BASELINE.commitSubject);
  });

  it('returns null when no baseline exists', () => {
    const result = readDeterminismBaseline('AISDLC-999', { artifactsDir: workdir });
    expect(result).toBeNull();
  });

  it('overwrites an existing baseline with a newer one', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const updated = { ...BASELINE, commitSubject: 'feat: updated subject' };
    recordDeterminismBaseline(updated, { artifactsDir: workdir });
    const loaded = readDeterminismBaseline(BASELINE.taskId, { artifactsDir: workdir });
    expect(loaded?.commitSubject).toBe('feat: updated subject');
  });
});

// ── Violation detection ───────────────────────────────────────────────

describe('checkDeterminismViolation', () => {
  it('returns violated=false when no baseline exists', () => {
    const result = checkDeterminismViolation(
      'AISDLC-999',
      {
        filesChanged: ['foo.ts'],
        commitSubject: 'feat: something',
      },
      { artifactsDir: workdir },
    );
    expect(result.violated).toBe(false);
  });

  it('returns violated=false when filesChanged and commitSubject match', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const result = checkDeterminismViolation(
      BASELINE.taskId,
      {
        filesChanged: [...BASELINE.filesChanged].reverse(), // different order, same set
        commitSubject: BASELINE.commitSubject,
      },
      { artifactsDir: workdir },
    );
    expect(result.violated).toBe(false);
  });

  it('returns violated=true when filesChanged differ', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const result = checkDeterminismViolation(
      BASELINE.taskId,
      {
        filesChanged: ['pipeline-cli/src/different.ts'],
        commitSubject: BASELINE.commitSubject,
      },
      { artifactsDir: workdir },
    );
    expect(result.violated).toBe(true);
    expect(result.reason).toMatch(/files changed differ/);
  });

  it('returns violated=true when commit subject differs', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const result = checkDeterminismViolation(
      BASELINE.taskId,
      {
        filesChanged: BASELINE.filesChanged,
        commitSubject: 'feat: completely different subject (AISDLC-123)',
      },
      { artifactsDir: workdir },
    );
    expect(result.violated).toBe(true);
    expect(result.reason).toMatch(/commit subject differs/);
  });

  it('includes baseline and current in the result when violated', () => {
    recordDeterminismBaseline(BASELINE, { artifactsDir: workdir });
    const current = { filesChanged: ['other.ts'], commitSubject: 'other subject' };
    const result = checkDeterminismViolation(BASELINE.taskId, current, { artifactsDir: workdir });
    expect(result.violated).toBe(true);
    expect(result.baseline?.commitSubject).toBe(BASELINE.commitSubject);
    expect(result.current?.filesChanged).toEqual(current.filesChanged);
  });
});
