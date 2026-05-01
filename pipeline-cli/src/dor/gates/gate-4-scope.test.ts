import { describe, expect, it } from 'vitest';
import { evaluateGate4 } from './gate-4-scope.js';
import type { IssueInput } from '../types.js';

function input(body: string): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body };
}

describe('evaluateGate4', () => {
  it('always returns skip — Stage A delegates to Stage B (Phase 2b)', () => {
    const v = evaluateGate4(input('short body'));
    expect(v.verdict).toBe('skip');
    expect(v.stage).toBe('A');
    expect(v.gateId).toBe(4);
    expect(v.confidence).toBe('low');
    expect(v.finding).toBeUndefined();
  });

  it('emits a soft heuristic finding when body is large', () => {
    const big = '\n'.repeat(220);
    const v = evaluateGate4(input(big));
    expect(v.verdict).toBe('skip');
    expect(v.finding).toMatch(/Soft heuristic/);
  });

  it('emits a soft heuristic finding when AC count is large', () => {
    const acs = Array.from({ length: 15 }, (_, i) => `- [ ] #${i + 1} item`).join('\n');
    const v = evaluateGate4(input(`## Acceptance Criteria\n${acs}`));
    expect(v.verdict).toBe('skip');
    expect(v.finding).toMatch(/Soft heuristic/);
  });
});
