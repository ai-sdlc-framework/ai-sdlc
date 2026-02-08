import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AutonomyPolicy } from '../core/types.js';
import {
  evaluatePromotion,
  parseDuration,
  DEFAULT_COOLDOWN_MS,
  type AgentMetrics,
} from './autonomy.js';

function makePolicy(overrides?: {
  minimumDuration?: string | null;
  cooldown?: string;
}): AutonomyPolicy {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AutonomyPolicy',
    metadata: { name: 'test-policy', labels: {}, annotations: {} },
    spec: {
      levels: [
        {
          level: 0,
          name: 'Supervised',
          description: 'Full supervision',
          permissions: { read: ['**'], write: [], execute: [] },
          guardrails: { requireApproval: 'all' },
          monitoring: 'continuous',
          minimumDuration: overrides?.minimumDuration ?? '2h',
        },
        {
          level: 1,
          name: 'Assisted',
          description: 'Assisted',
          permissions: { read: ['**'], write: ['src/**'], execute: [] },
          guardrails: { requireApproval: 'all' },
          monitoring: 'continuous',
          minimumDuration: null,
        },
      ],
      promotionCriteria: {
        '0-to-1': {
          minimumTasks: 5,
          conditions: [{ metric: 'approval-rate', operator: '>=', threshold: 90 }],
          requiredApprovals: [],
        },
      },
      demotionTriggers: [
        {
          trigger: 'security-violation',
          action: 'demote-to-0',
          cooldown: overrides?.cooldown ?? '1h',
        },
      ],
    },
  } as unknown as AutonomyPolicy;
}

function makeAgent(overrides?: Partial<AgentMetrics>): AgentMetrics {
  return {
    name: 'test-agent',
    currentLevel: 0,
    totalTasksCompleted: 10,
    metrics: { 'approval-rate': 95 },
    approvals: [],
    ...overrides,
  };
}

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('60s')).toBe(60_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDuration('2w')).toBe(1_209_600_000);
  });

  it('parses ISO 8601 duration', () => {
    expect(parseDuration('PT1H')).toBe(3_600_000);
    expect(parseDuration('P1D')).toBe(86_400_000);
    expect(parseDuration('PT30M')).toBe(1_800_000);
    expect(parseDuration('P1DT2H30M')).toBe(95_400_000);
  });

  it('returns 0 for empty string', () => {
    expect(parseDuration('')).toBe(0);
  });
});

describe('minimumDuration enforcement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks promotion during minimumDuration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T01:00:00Z'));

    const policy = makePolicy({ minimumDuration: '2h' });
    const agent = makeAgent({
      promotedAt: new Date('2025-01-01T00:00:00Z'), // 1 hour ago, need 2h
    });

    const result = evaluatePromotion(policy, agent);
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions.some((c) => c.includes('Minimum duration'))).toBe(true);
  });

  it('allows promotion after minimumDuration elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T03:00:00Z'));

    const policy = makePolicy({ minimumDuration: '2h' });
    const agent = makeAgent({
      promotedAt: new Date('2025-01-01T00:00:00Z'), // 3 hours ago
    });

    const result = evaluatePromotion(policy, agent);
    expect(result.eligible).toBe(true);
  });
});

describe('demotion cooldown enforcement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cooldown blocks re-promotion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:30:00Z'));

    const policy = makePolicy({ cooldown: '1h', minimumDuration: null });
    const agent = makeAgent({
      demotedAt: new Date('2025-01-01T00:00:00Z'), // 30 min ago, need 1h
    });

    const result = evaluatePromotion(policy, agent);
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions.some((c) => c.includes('cooldown'))).toBe(true);
  });

  it('cooldown expires and allows promotion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T02:00:00Z'));

    const policy = makePolicy({ cooldown: '1h', minimumDuration: null });
    const agent = makeAgent({
      demotedAt: new Date('2025-01-01T00:00:00Z'), // 2 hours ago
    });

    const result = evaluatePromotion(policy, agent);
    expect(result.eligible).toBe(true);
  });

  it('no cooldown check when never demoted', () => {
    const policy = makePolicy({ minimumDuration: null });
    const agent = makeAgent(); // no demotedAt

    const result = evaluatePromotion(policy, agent);
    expect(result.eligible).toBe(true);
  });
});

describe('DEFAULT_COOLDOWN_MS', () => {
  it('is 1 hour', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(3_600_000);
  });
});
