/**
 * Unit tests for RFC-0024 §9.3 CapturesPending filter (AISDLC-269).
 *
 * AC#7: RFC-0011 + RFC-0015 integration — confirms capture flow does NOT block
 * dispatch when the feature flag is off (degrade-open), and DOES block when
 * there are pending captures with the flag on.
 */

import { describe, expect, it } from 'vitest';
import { checkCapturesPending } from './captures-pending.js';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeHasPending(hasPending: boolean): () => boolean {
  return () => hasPending;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkCapturesPending — feature flag OFF (degrade-open)', () => {
  const envFlagOff = { AI_SDLC_EMERGENT_CAPTURE: '' };

  it('passes when flag is unset (backward-compatible default)', () => {
    const result = checkCapturesPending({
      taskId: 'AISDLC-100',
      hasPendingCaptures: makeHasPending(true), // would reject if flag were on
      env: envFlagOff,
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('CapturesPending');
    expect(result.detail).toBeUndefined();
  });

  it('passes even when there are pending captures — flag off means degrade-open', () => {
    const result = checkCapturesPending({
      taskId: 'AISDLC-200',
      hasPendingCaptures: makeHasPending(true),
      env: { AI_SDLC_EMERGENT_CAPTURE: undefined },
    });
    expect(result.passed).toBe(true);
  });
});

describe('checkCapturesPending — feature flag ON', () => {
  const envFlagOn = { AI_SDLC_EMERGENT_CAPTURE: 'experimental' };

  it('passes when no captures are pending for the task (AC#7)', () => {
    const result = checkCapturesPending({
      taskId: 'AISDLC-150',
      hasPendingCaptures: makeHasPending(false),
      env: envFlagOn,
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('CapturesPending');
    expect(result.detail).toBeUndefined();
  });

  it('rejects when captures are pending for the task', () => {
    const result = checkCapturesPending({
      taskId: 'AISDLC-150',
      hasPendingCaptures: makeHasPending(true),
      env: envFlagOn,
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('CapturesPending');
    expect(result.reason).toContain('AISDLC-150');
    expect(result.reason).toContain('triage=tbd');
    expect(result.detail).toMatchObject({
      kind: 'captures-pending',
      issueId: 'AISDLC-150',
    });
  });

  it('detail.advisory contains actionable CLI command', () => {
    const result = checkCapturesPending({
      taskId: 'AISDLC-X',
      hasPendingCaptures: makeHasPending(true),
      env: envFlagOn,
    });
    expect(result.detail).toMatchObject({
      kind: 'captures-pending',
      advisory: expect.stringContaining('cli-capture list --pending'),
    });
  });
});

describe('checkCapturesPending — truthy flag values', () => {
  for (const val of ['1', 'true', 'yes', 'on', 'experimental', 'EXPERIMENTAL']) {
    it(`treats AI_SDLC_EMERGENT_CAPTURE="${val}" as enabled`, () => {
      const result = checkCapturesPending({
        taskId: 'AISDLC-1',
        hasPendingCaptures: makeHasPending(true),
        env: { AI_SDLC_EMERGENT_CAPTURE: val },
      });
      expect(result.passed).toBe(false);
    });
  }

  for (const val of ['', 'false', 'no', 'off', '0']) {
    it(`treats AI_SDLC_EMERGENT_CAPTURE="${val}" as disabled`, () => {
      const result = checkCapturesPending({
        taskId: 'AISDLC-1',
        hasPendingCaptures: makeHasPending(true),
        env: { AI_SDLC_EMERGENT_CAPTURE: val },
      });
      expect(result.passed).toBe(true);
    });
  }
});
