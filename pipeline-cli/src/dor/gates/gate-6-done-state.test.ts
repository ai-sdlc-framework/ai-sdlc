import { describe, expect, it } from 'vitest';
import { evaluateGate6 } from './gate-6-done-state.js';
import type { IssueInput } from '../types.js';

function input(body: string): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body };
}

describe('evaluateGate6', () => {
  it('always returns skip — Stage A defers to Stage B (Phase 2b)', () => {
    const v = evaluateGate6(input('## Description\nSome description.'));
    expect(v.verdict).toBe('skip');
    expect(v.gateId).toBe(6);
    expect(v.finding).toBeUndefined();
  });
  it('emits a soft heuristic when description is missing', () => {
    const v = evaluateGate6(input('no description heading here'));
    expect(v.verdict).toBe('skip');
    expect(v.finding).toMatch(/Soft heuristic/);
  });
});
