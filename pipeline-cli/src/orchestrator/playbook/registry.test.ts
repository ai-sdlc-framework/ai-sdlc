/**
 * Registry consistency test (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * Single invariant: the catalogued mode list (`CATALOGUED_MODES`) must
 * exactly match the registry order in `PLAYBOOK_HANDLERS`. This test is
 * the canary for "added a 10th mode without exporting its handler"
 * regressions.
 */

import { describe, expect, it } from 'vitest';

import {
  assertRegistryConsistency,
  CATALOGUED_MODES,
  PLAYBOOK_HANDLERS,
  findHandler,
} from './index.js';

describe('playbook registry', () => {
  it('asserts consistency without throwing on the shipped registry', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });

  it('exports exactly 9 handlers (the §5.1 set + StackedPRBaseSquashed)', () => {
    expect(PLAYBOOK_HANDLERS).toHaveLength(9);
  });

  it('handler.mode matches CATALOGUED_MODES position by position', () => {
    expect(PLAYBOOK_HANDLERS.map((h) => h.mode)).toEqual([...CATALOGUED_MODES]);
  });

  it('every catalogued mode has a non-zero default budget', () => {
    for (const h of PLAYBOOK_HANDLERS) {
      expect(h.budget).toBeGreaterThan(0);
    }
  });

  it('findHandler returns the right entry by mode', () => {
    expect(findHandler('SecretScanBlocked')?.mode).toBe('SecretScanBlocked');
    expect(findHandler('UnknownFailureMode')).toBeUndefined();
  });
});
