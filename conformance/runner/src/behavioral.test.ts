import { describe, it, expect } from 'vitest';
import { isBehavioralFixture, runBehavioralTest, runBehavioralTestAsync } from './behavioral.js';
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

  it('dispatches complexity-routing for low complexity', () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'Low complexity',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'complexity-routing',
        input: {
          complexityInput: {
            filesAffected: 1,
            linesOfChange: 10,
          },
        },
        expected: {
          minScore: 1,
          maxScore: 3,
          strategy: 'fully-autonomous',
        },
      },
    };

    const result = runBehavioralTest(fixture, 'test.yaml');
    expect(result.passed).toBe(true);
  });

  it('dispatches complexity-routing for high complexity', () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'High complexity',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'complexity-routing',
        input: {
          complexityInput: {
            filesAffected: 50,
            linesOfChange: 2000,
            securitySensitive: true,
            apiChange: true,
            databaseMigration: true,
            crossServiceChange: true,
          },
        },
        expected: {
          minScore: 8,
          maxScore: 10,
          strategy: 'human-led',
        },
      },
    };

    const result = runBehavioralTest(fixture, 'test.yaml');
    expect(result.passed).toBe(true);
  });
});

describe('runBehavioralTestAsync()', () => {
  it('runs orchestration-error test with dependency failure', async () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'Dependency failure',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'orchestration-error',
        input: {
          plan: {
            pattern: 'sequential',
            steps: [{ agent: 'builder' }, { agent: 'tester', dependsOn: ['builder'] }],
          },
          agents: {
            builder: {
              apiVersion: API_VERSION,
              kind: 'AgentRole',
              metadata: { name: 'builder' },
              spec: { role: 'Builder', goal: 'Build', tools: ['compiler'] },
            },
            tester: {
              apiVersion: API_VERSION,
              kind: 'AgentRole',
              metadata: { name: 'tester' },
              spec: { role: 'Tester', goal: 'Test', tools: ['runner'] },
            },
          },
          failAgent: 'builder',
        },
        expected: {
          success: false,
          failedAgents: ['builder', 'tester'],
        },
      },
    };

    const result = await runBehavioralTestAsync(fixture, 'test.yaml');
    expect(result.passed).toBe(true);
  });

  it('runs orchestration-error test with missing agent', async () => {
    const fixture: BehavioralFixture = {
      kind: 'BehavioralTest',
      apiVersion: API_VERSION,
      description: 'Agent not found',
      metadata: { conformanceLevel: 'core' },
      test: {
        type: 'orchestration-error',
        input: {
          plan: {
            pattern: 'sequential',
            steps: [{ agent: 'ghost-agent' }],
          },
          agents: {},
          failAgent: null,
        },
        expected: {
          success: false,
          failedAgents: ['ghost-agent'],
        },
      },
    };

    const result = await runBehavioralTestAsync(fixture, 'test.yaml');
    expect(result.passed).toBe(true);
  });
});
