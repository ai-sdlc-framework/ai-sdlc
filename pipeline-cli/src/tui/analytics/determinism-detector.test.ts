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
  shouldSampleDeterminismComposite,
  isTopDecileBlastRadius,
  DETERMINISM_SAMPLE_RATE,
  DETERMINISM_SAMPLE_FRACTION,
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

// ── Phase 5 composite sampling (AISDLC-306 / OQ-7) ────────────────────

describe('shouldSampleDeterminismComposite', () => {
  it('fires on requires-determinism opt-in regardless of dispatch count', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 7,
      requiresDeterminism: true,
      blastRadiusEffectivePriority: null,
      isTopBlastRadiusDecile: false,
    });
    expect(decision.sample).toBe(true);
    expect(decision.reason).toBe('requires-determinism-flag');
  });

  it('fires on top-decile blast-radius even when requires-determinism is false', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 7,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 4,
      isTopBlastRadiusDecile: true,
    });
    expect(decision.sample).toBe(true);
    expect(decision.reason).toBe('top-decile-blast-radius');
  });

  it('fires on flat sample rate at 1-in-50 multiples', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 50,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 1,
      isTopBlastRadiusDecile: false,
    });
    expect(decision.sample).toBe(true);
    expect(decision.reason).toBe('flat-sample-rate');
  });

  it('does NOT fire on a low-blast non-multiple dispatch with default config', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 7,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 1,
      isTopBlastRadiusDecile: false,
    });
    expect(decision.sample).toBe(false);
    expect(decision.reason).toBe('not-sampled');
  });

  it('alwaysOnRequiresDeterminism=false disables the requires-determinism gate', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 7,
      requiresDeterminism: true,
      blastRadiusEffectivePriority: 1,
      isTopBlastRadiusDecile: false,
      alwaysOnRequiresDeterminism: false,
    });
    expect(decision.sample).toBe(false);
  });

  it('alwaysOnTopBlastRadiusDecile=false disables the top-decile gate', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 7,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 4,
      isTopBlastRadiusDecile: true,
      alwaysOnTopBlastRadiusDecile: false,
    });
    expect(decision.sample).toBe(false);
  });

  it('honors a custom sample rate of 0.1 (1-in-10)', () => {
    const decision = shouldSampleDeterminismComposite({
      dispatchCount: 10,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 1,
      isTopBlastRadiusDecile: false,
      defaultSampleRate: 0.1,
    });
    expect(decision.sample).toBe(true);
    expect(decision.reason).toBe('flat-sample-rate');
  });

  it('sample rate 0 disables flat sampling but preserves always-on rules', () => {
    const noFlat = shouldSampleDeterminismComposite({
      dispatchCount: 100,
      requiresDeterminism: false,
      blastRadiusEffectivePriority: 1,
      isTopBlastRadiusDecile: false,
      defaultSampleRate: 0,
    });
    expect(noFlat.sample).toBe(false);

    const stillAlwaysOn = shouldSampleDeterminismComposite({
      dispatchCount: 100,
      requiresDeterminism: true,
      blastRadiusEffectivePriority: 4,
      isTopBlastRadiusDecile: true,
      defaultSampleRate: 0,
    });
    expect(stillAlwaysOn.sample).toBe(true);
  });

  it('default sample rate matches DETERMINISM_SAMPLE_FRACTION (0.02)', () => {
    expect(DETERMINISM_SAMPLE_FRACTION).toBeCloseTo(1 / 50);
  });
});

describe('isTopDecileBlastRadius', () => {
  it('returns false for empty corpus', () => {
    expect(isTopDecileBlastRadius([], 4)).toBe(false);
  });

  it('returns false when candidate priority is null', () => {
    expect(isTopDecileBlastRadius([1, 2, 3, 4], null)).toBe(false);
  });

  it('identifies the top decile in a 20-item corpus', () => {
    // 1..20: 90th percentile (nearest-rank) lands at index ceil(0.9*20)-1 = 17,
    // sorted[17] = 18. So candidates >= 18 are top decile.
    const corpus = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(isTopDecileBlastRadius(corpus, 18)).toBe(true);
    expect(isTopDecileBlastRadius(corpus, 19)).toBe(true);
    expect(isTopDecileBlastRadius(corpus, 20)).toBe(true);
    expect(isTopDecileBlastRadius(corpus, 17)).toBe(false);
  });

  it('ignores invalid corpus entries (null/undefined/NaN)', () => {
    const corpus = [1, null, undefined, NaN, 2, 3, 4];
    // Valid corpus = [1, 2, 3, 4], 90th pct = sorted[ceil(0.9*4)-1]=sorted[3]=4
    expect(isTopDecileBlastRadius(corpus, 4)).toBe(true);
    expect(isTopDecileBlastRadius(corpus, 3)).toBe(false);
  });

  it('handles single-item corpus correctly', () => {
    expect(isTopDecileBlastRadius([5], 5)).toBe(true);
    expect(isTopDecileBlastRadius([5], 4)).toBe(false);
  });
});
