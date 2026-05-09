/**
 * Filter — Dispatchability detection (AISDLC-243) unit tests.
 *
 * Covers:
 *   - No `dispatchable` field → passed (back-compat default: true).
 *   - `dispatchable: true` → passed.
 *   - `dispatchable: false` → failed + structured detail.
 *   - `dispatchable: false` with `dispatchableReason` → reason propagated to detail.
 *   - `dispatchable: false` without `dispatchableReason` → default reason used.
 */

import { describe, expect, it } from 'vitest';
import { checkDispatchability } from './dispatchability.js';

describe('checkDispatchability', () => {
  it('passes when dispatchable field is absent (back-compat default)', () => {
    const result = checkDispatchability({ taskId: 'AISDLC-A' });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Dispatchability');
    expect(result.detail).toBeUndefined();
  });

  it('passes when dispatchable is undefined (explicit undefined)', () => {
    const result = checkDispatchability({ taskId: 'AISDLC-A', dispatchable: undefined });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Dispatchability');
  });

  it('passes when dispatchable is true', () => {
    const result = checkDispatchability({ taskId: 'AISDLC-A', dispatchable: true });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('Dispatchability');
    expect(result.detail).toBeUndefined();
  });

  it('fails when dispatchable is false', () => {
    const result = checkDispatchability({ taskId: 'AISDLC-178.7', dispatchable: false });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('Dispatchability');
    expect(result.reason).toBeTruthy();
    expect(result.detail).toMatchObject({ kind: 'not-dispatchable' });
  });

  it('uses dispatchableReason in detail when provided', () => {
    const result = checkDispatchability({
      taskId: 'AISDLC-178.7',
      dispatchable: false,
      dispatchableReason: 'Operator soak phase — no code work',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Operator soak phase — no code work');
    expect(result.detail).toEqual({
      kind: 'not-dispatchable',
      dispatchableReason: 'Operator soak phase — no code work',
    });
  });

  it('uses a default reason when dispatchableReason is absent', () => {
    const result = checkDispatchability({ taskId: 'AISDLC-115.8', dispatchable: false });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('marked dispatchable:false in frontmatter');
    expect(result.detail).toEqual({
      kind: 'not-dispatchable',
      dispatchableReason: 'marked dispatchable:false in frontmatter',
    });
  });
});
