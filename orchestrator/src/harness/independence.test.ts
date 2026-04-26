import { describe, it, expect } from 'vitest';
import {
  enforceIndependence,
  validateIndependenceGraph,
  CyclicIndependenceConstraintError,
} from './independence.js';
import type { HarnessName } from './types.js';

describe('enforceIndependence', () => {
  it('removes harnesses that ran upstream stages named in requiresIndependentHarnessFrom', () => {
    const result = enforceIndependence(
      ['codex', 'claude-code'] as HarnessName[],
      ['implement'],
      [{ stage: 'implement', resolvedHarness: 'claude-code' }],
    );
    expect(result.effectiveChain).toEqual(['codex']);
    expect(result.removed).toEqual(['claude-code']);
    expect(result.forbidden).toEqual(['claude-code']);
    expect(result.violated).toBe(false);
  });

  it('preserves the chain when no upstream stage is named', () => {
    const result = enforceIndependence(
      ['claude-code', 'codex'] as HarnessName[],
      [],
      [{ stage: 'implement', resolvedHarness: 'claude-code' }],
    );
    expect(result.effectiveChain).toEqual(['claude-code', 'codex']);
    expect(result.violated).toBe(false);
  });

  it('reports violated when the filter empties the chain', () => {
    const result = enforceIndependence(
      ['claude-code'] as HarnessName[],
      ['implement'],
      [{ stage: 'implement', resolvedHarness: 'claude-code' }],
    );
    expect(result.effectiveChain).toEqual([]);
    expect(result.violated).toBe(true);
  });

  it('multiple upstream stages contribute to forbidden set', () => {
    const result = enforceIndependence(
      ['claude-code', 'codex', 'gemini-cli'] as HarnessName[],
      ['implement', 'plan'],
      [
        { stage: 'implement', resolvedHarness: 'claude-code' },
        { stage: 'plan', resolvedHarness: 'codex' },
      ],
    );
    expect(result.effectiveChain).toEqual(['gemini-cli']);
    expect(result.forbidden.sort()).toEqual(['claude-code', 'codex'].sort());
  });

  it('ignores upstream names that are not in the upstreamRuns map', () => {
    const result = enforceIndependence(
      ['claude-code', 'codex'] as HarnessName[],
      ['implement', 'phantom'],
      [{ stage: 'implement', resolvedHarness: 'claude-code' }],
    );
    expect(result.effectiveChain).toEqual(['codex']);
    expect(result.forbidden).toEqual(['claude-code']);
  });
});

describe('validateIndependenceGraph', () => {
  it('returns [] for a valid graph (review-security depends on implement)', () => {
    const cycles = validateIndependenceGraph([
      { name: 'implement' },
      { name: 'review-security', requiresIndependentHarnessFrom: ['implement'] },
    ]);
    expect(cycles).toEqual([]);
  });

  it('flags self-references as cycles', () => {
    const cycles = validateIndependenceGraph([
      { name: 'implement', requiresIndependentHarnessFrom: ['implement'] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].stage).toBe('implement');
  });

  it('flags references to downstream stages as cycles', () => {
    const cycles = validateIndependenceGraph([
      { name: 'plan', requiresIndependentHarnessFrom: ['implement'] },
      { name: 'implement' },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].stage).toBe('plan');
  });

  it('flags references to unknown stages', () => {
    const cycles = validateIndependenceGraph([
      { name: 'review-security', requiresIndependentHarnessFrom: ['nonexistent'] },
    ]);
    expect(cycles[0].references).toMatch(/unknown stage/);
  });

  it('CyclicIndependenceConstraintError captures all cycles', () => {
    const cycles = [
      { stage: 's1', references: 'self' },
      { stage: 's2', references: "'s3' is downstream" },
    ];
    const err = new CyclicIndependenceConstraintError(cycles);
    expect(err.message).toMatch(/s1/);
    expect(err.message).toMatch(/s2/);
    expect(err.cycles).toEqual(cycles);
  });
});
