/**
 * PR comment renderer tests — RFC-0016 Phase 5 (AISDLC-283).
 *
 * Coverage:
 *  AC #3 — state token shared across CLI/dashboard/Slack/PR-comment surfaces
 *  AC #4 — comment body structure + idempotent marker
 *  AC #5 — marker always present (idempotency predicate)
 */

import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_COMMENT_MARKER,
  hasEstimateMarker,
  renderCalibrationStateToken,
  renderEstimateComment,
} from './pr-comment.js';
import type { StageAResult } from './types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal Stage A result for testing. */
function makeStageAResult(overrides: Partial<StageAResult> = {}): StageAResult {
  return {
    taskId: 'AISDLC-283',
    taskClass: 'feature',
    classSource: 'heuristic',
    signals: [
      {
        id: 1,
        name: 'file scope count',
        inputs: { fileCount: 3 },
        result: { kind: 'bucket', bucket: 'M' },
      },
      {
        id: 5,
        name: 'dependency depth',
        inputs: { blockerCount: 0 },
        result: { kind: 'bump', delta: 0 },
      },
    ],
    candidateBucket: 'M',
    confidence: 'high',
    escalateToStageB: false,
    rationale: 'all signals agree on M',
    ...overrides,
  };
}

const FROZEN_NOW = new Date('2026-05-17T12:00:00.000Z');
const frozenClock = (): Date => FROZEN_NOW;

// ── renderEstimateComment() ───────────────────────────────────────────────────

describe('renderEstimateComment() — AC #4 comment body + AC #5 idempotent marker', () => {
  it('always includes the idempotent marker at the top', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toMatch(new RegExp(`^${ESTIMATE_COMMENT_MARKER}`));
    expect(result.hasMarker).toBe(true);
  });

  it('renders the estimated bucket + state token in one line', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 23,
      meanBucketMiss: 0.6,
      now: frozenClock,
    });
    // Calibrated with +15% bias
    expect(result.body).toContain('**Estimated:** M (calibrated, n=23, bias=+15%)');
  });

  it('renders uncalibrated state token for n=0 — AC #3', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('(uncalibrated)');
    expect(result.stateToken).toBe('(uncalibrated)');
  });

  it('renders warming state token for n=3 — AC #3', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 3,
      now: frozenClock,
    });
    expect(result.body).toContain('(warming, n=3)');
    expect(result.stateToken).toBe('(warming, n=3)');
  });

  it('appends high-variance qualifier when variance ≥ 2 — AC #3', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 10,
      meanBucketMiss: 0.6,
      estimateVariance: 2,
      now: frozenClock,
    });
    expect(result.body).toContain('; high-variance)');
    expect(result.stateToken).toContain('high-variance');
  });

  it('renders 2-bucket range estimates correctly', () => {
    const stageAResult = makeStageAResult({
      candidateBucket: 'S',
      candidateRange: { low: 'S', high: 'M' },
      confidence: 'medium',
    });
    const result = renderEstimateComment({
      stageAResult,
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('**Estimated:** S-M');
  });

  it('includes Class line', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult({ taskClass: 'bug' }),
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('**Class:** bug');
  });

  it('includes Stage A signals line', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('**Stage A signals:**');
    expect(result.body).toContain('file scope count');
  });

  it('includes Variance across runs line', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 0,
      estimateVariance: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('**Variance across runs:** 0 buckets (single estimate, n=1)');
  });

  it('includes Last updated timestamp', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 0,
      now: frozenClock,
    });
    expect(result.body).toContain('*Last updated: 2026-05-17T12:00:00.000Z*');
  });

  it('appends Actual line when actualBucket is provided (post-merge)', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 5,
      actualBucket: 'S',
      now: frozenClock,
    });
    expect(result.body).toContain('**Actual:** S');
  });

  it('does NOT include Actual line when actualBucket is absent (pre-merge)', () => {
    const result = renderEstimateComment({
      stageAResult: makeStageAResult(),
      calibrationN: 5,
      now: frozenClock,
    });
    expect(result.body).not.toContain('**Actual:**');
  });
});

// ── hasEstimateMarker() ───────────────────────────────────────────────────────

describe('hasEstimateMarker() — AC #5 idempotency predicate', () => {
  it('returns true for a body containing the marker', () => {
    const body = `${ESTIMATE_COMMENT_MARKER}\nsome content`;
    expect(hasEstimateMarker(body)).toBe(true);
  });

  it('returns false for a body without the marker', () => {
    expect(hasEstimateMarker('No estimate here.')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(hasEstimateMarker('')).toBe(false);
  });
});

// ── renderCalibrationStateToken() ────────────────────────────────────────────

describe('renderCalibrationStateToken() — shared surface token (AC #3)', () => {
  it('delegates to formatStateToken — uncalibrated', () => {
    expect(renderCalibrationStateToken('feature', 0, null)).toBe('(uncalibrated)');
  });

  it('delegates to formatStateToken — warming', () => {
    expect(renderCalibrationStateToken('bug', 3, null)).toBe('(warming, n=3)');
  });

  it('delegates to formatStateToken — calibrated with bias', () => {
    expect(renderCalibrationStateToken('chore', 10, 1.0)).toBe('(calibrated, n=10, bias=+25%)');
  });

  it('propagates high-variance qualifier', () => {
    expect(renderCalibrationStateToken('feature', 10, 0.6, 2)).toBe(
      '(calibrated, n=10, bias=+15%; high-variance)',
    );
  });
});
