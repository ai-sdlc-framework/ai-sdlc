/**
 * Substrate type-surface tests — guard the public type names + constants
 * (AISDLC-321 AC-8 + AC-10: documenting the public API for downstream
 * consumers means asserting the type names + the constants don't drift
 * silently).
 *
 * Pure type/constants check — no I/O.
 */

import { describe, expect, it } from 'vitest';

import { ALL_TASK_TYPES, type ClassifierTaskType } from './types.js';

describe('ClassifierTaskType', () => {
  it('exposes exactly the 5 task types AC-8 documents', () => {
    expect([...ALL_TASK_TYPES]).toEqual([
      'capture-triage',
      'capture-severity',
      'pr-comment-is-capture',
      'dor-answer-is-new-concern',
      'decision-recommendation',
    ]);
  });

  it('is a readonly tuple — mutation throws or no-ops at runtime', () => {
    // Object.freeze gives shallow immutability: in strict mode push() throws.
    expect(Object.isFrozen(ALL_TASK_TYPES)).toBe(true);
  });

  it('compile-time check — type union matches the runtime tuple', () => {
    // If a contributor adds a new task type to the type union without
    // updating ALL_TASK_TYPES, this test fails to compile (the exhaustive
    // switch in the helper below is the assertion).
    const exhaustive = (t: ClassifierTaskType): string => {
      switch (t) {
        case 'capture-triage':
          return 'a';
        case 'capture-severity':
          return 'b';
        case 'pr-comment-is-capture':
          return 'c';
        case 'dor-answer-is-new-concern':
          return 'd';
        case 'decision-recommendation':
          return 'e';
        default: {
          const _never: never = t;
          return _never;
        }
      }
    };
    for (const t of ALL_TASK_TYPES) {
      expect(typeof exhaustive(t)).toBe('string');
    }
  });
});
