/**
 * Filter — Operator-blocked detection (AISDLC-223) tests.
 *
 * Covers:
 *   - No `blocked` field → passed.
 *   - `blocked` present but `reason` is absent/empty → passed.
 *   - `blocked.reason` non-empty → failed + structured detail with reason.
 *   - `blocked.until` propagated to detail when present.
 *   - `blocked.unblockedBy` propagated to detail when present.
 *   - Empty `unblockedBy` array omitted from detail.
 */

import { describe, expect, it } from 'vitest';
import { checkBlocked } from './blocked.js';
import type { BlockedFrontmatter } from './blocked.js';

describe('checkBlocked', () => {
  it('passes when blocked field is absent (no frontmatter field)', () => {
    const result = checkBlocked({ taskId: 'AISDLC-A' });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Blocked');
    expect(result.detail).toBeUndefined();
  });

  it('passes when blocked is undefined (explicit undefined)', () => {
    const result = checkBlocked({ taskId: 'AISDLC-A', blocked: undefined });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Blocked');
  });

  it('passes when blocked.reason is absent', () => {
    const blocked: BlockedFrontmatter = {};
    const result = checkBlocked({ taskId: 'AISDLC-A', blocked });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Blocked');
  });

  it('passes when blocked.reason is an empty string', () => {
    const blocked: BlockedFrontmatter = { reason: '' };
    const result = checkBlocked({ taskId: 'AISDLC-A', blocked });
    expect(result.passed).toBe(true);
  });

  it('passes when blocked.reason is whitespace-only', () => {
    const blocked: BlockedFrontmatter = { reason: '   ' };
    const result = checkBlocked({ taskId: 'AISDLC-A', blocked });
    expect(result.passed).toBe(true);
  });

  it('fails when blocked.reason is a non-empty string', () => {
    const blocked: BlockedFrontmatter = {
      reason: 'Soaking — feature flag promotion gated on AISDLC-116 evidence',
    };
    const result = checkBlocked({ taskId: 'AISDLC-A', blocked });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('Blocked');
    expect(result.reason).toBe('Soaking — feature flag promotion gated on AISDLC-116 evidence');
    expect(result.detail).toEqual({
      kind: 'blocked',
      reason: 'Soaking — feature flag promotion gated on AISDLC-116 evidence',
    });
  });

  it('carries until in detail when blocked.until is set', () => {
    const blocked: BlockedFrontmatter = {
      reason: 'On hold for soak',
      until: '2026-05-13',
    };
    const result = checkBlocked({ taskId: 'AISDLC-B', blocked });
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({
      kind: 'blocked',
      reason: 'On hold for soak',
      until: '2026-05-13',
    });
  });

  it('carries unblockedBy in detail when blocked.unblockedBy is a non-empty array', () => {
    const blocked: BlockedFrontmatter = {
      reason: 'Waiting for AISDLC-116',
      unblockedBy: ['AISDLC-116'],
    };
    const result = checkBlocked({ taskId: 'AISDLC-C', blocked });
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({
      kind: 'blocked',
      reason: 'Waiting for AISDLC-116',
      unblockedBy: ['AISDLC-116'],
    });
  });

  it('omits unblockedBy from detail when the array is empty', () => {
    const blocked: BlockedFrontmatter = {
      reason: 'Waiting',
      unblockedBy: [],
    };
    const result = checkBlocked({ taskId: 'AISDLC-D', blocked });
    expect(result.passed).toBe(false);
    const d = result.detail;
    expect(d && 'unblockedBy' in d ? d.unblockedBy : 'absent').toBe('absent');
  });

  it('carries all optional sub-keys when all are present', () => {
    const blocked: BlockedFrontmatter = {
      reason: 'Soak window open',
      until: '2026-06-01',
      unblockedBy: ['AISDLC-116', 'AISDLC-117'],
    };
    const result = checkBlocked({ taskId: 'AISDLC-E', blocked });
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({
      kind: 'blocked',
      reason: 'Soak window open',
      until: '2026-06-01',
      unblockedBy: ['AISDLC-116', 'AISDLC-117'],
    });
  });
});
