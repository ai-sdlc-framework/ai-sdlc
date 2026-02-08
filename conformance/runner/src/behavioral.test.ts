import { describe, it, expect } from 'vitest';
import { isBehavioralFixture, runBehavioralTest } from './behavioral.js';
import type { BehavioralFixture } from './behavioral.js';
import { API_VERSION } from '@ai-sdlc/reference';

describe('isBehavioralFixture()', () => {
  it('returns true for BehavioralTest kind', () => {
    expect(
      isBehavioralFixture({
        kind: 'BehavioralTest',
        apiVersion: API_VERSION,
        description: 'test',
        metadata: { conformanceLevel: 'core' },
        test: { type: 'quality-gate-evaluation', input: {}, expected: {} },
      }),
    ).toBe(true);
  });

  it('returns false for non-behavioral docs', () => {
    expect(isBehavioralFixture({ kind: 'QualityGate', apiVersion: API_VERSION })).toBe(false);
    expect(isBehavioralFixture(null)).toBe(false);
    expect(isBehavioralFixture(undefined)).toBe(false);
    expect(isBehavioralFixture(42)).toBe(false);
  });
});

describe('runBehavioralTest()', () => {
  it('dispatches quality-gate-evaluation correctly', () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'Metric passes',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'quality-gate-evaluation',
        input: {
          qualityGate: {
            apiVersion: API_VERSION,
            kind: 'QualityGate',
            metadata: { name: 'test' },
            spec: {
              gates: [
                {
                  name: 'cov',
                  enforcement: 'hard-mandatory',
                  rule: { metric: 'coverage', operator: '>=', threshold: 80 },
                },
              ],
            },
          },
          context: {
            authorType: 'ai-agent',
            repository: 'org/repo',
            metrics: { coverage: 90 },
          },
        },
        expected: { allowed: true },
      },
    };

    const result = runBehavioralTest(fixture, 'test.yaml');
    expect(result.passed).toBe(true);
  });

  it('returns failure for unknown test type', () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'Unknown',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'non-existent-type',
        input: {},
        expected: {},
      },
    };

    const result = runBehavioralTest(fixture, 'test.yaml');
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Unknown');
  });
});
