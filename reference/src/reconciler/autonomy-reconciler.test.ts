import { describe, it, expect, vi } from 'vitest';
import { createAutonomyReconciler } from './autonomy-reconciler.js';
import type { AutonomyPolicy } from '../core/types.js';
import type { AgentMetrics } from '../policy/autonomy.js';

const API = 'ai-sdlc.io/v1alpha1' as const;

function makePolicy(): AutonomyPolicy {
  return {
    apiVersion: API,
    kind: 'AutonomyPolicy',
    metadata: { name: 'test-policy' },
    spec: {
      levels: [
        {
          level: 0,
          name: 'Supervised',
          permissions: { read: ['**'], write: [], execute: [] },
          guardrails: { requireApproval: 'all' },
          monitoring: 'continuous',
        },
        {
          level: 1,
          name: 'Assisted',
          permissions: { read: ['**'], write: ['src/**'], execute: ['build'] },
          guardrails: { requireApproval: 'security-critical-only' },
          monitoring: 'real-time-notification',
        },
        {
          level: 2,
          name: 'Semi-Auto',
          permissions: { read: ['**'], write: ['**'], execute: ['**'] },
          guardrails: { requireApproval: 'none' },
          monitoring: 'audit-log',
        },
      ],
      promotionCriteria: {
        '0-to-1': {
          minimumTasks: 10,
          conditions: [{ metric: 'approval-rate', operator: '>=', threshold: 0.9 }],
          requiredApprovals: ['tech-lead'],
        },
      },
      demotionTriggers: [{ trigger: 'security-incident', action: 'demote-to-0', cooldown: '7d' }],
    },
    status: {
      agents: [{ name: 'agent-1', currentLevel: 0 }],
    },
  };
}

describe('createAutonomyReconciler', () => {
  it('promotes eligible agents', async () => {
    const onPromotion = vi.fn();
    const policy = makePolicy();
    const metrics: AgentMetrics = {
      name: 'agent-1',
      currentLevel: 0,
      totalTasksCompleted: 15,
      metrics: { 'approval-rate': 0.95 },
      approvals: ['tech-lead'],
    };

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => metrics,
      getActiveTriggers: () => [],
      onPromotion,
    });

    const result = await reconciler(policy);
    expect(result.type).toBe('success');
    expect(policy.status?.agents?.[0].currentLevel).toBe(1);
    expect(onPromotion).toHaveBeenCalledWith('agent-1', 0, 1);
  });

  it('does not promote ineligible agents', async () => {
    const policy = makePolicy();
    const metrics: AgentMetrics = {
      name: 'agent-1',
      currentLevel: 0,
      totalTasksCompleted: 5, // below minimum
      metrics: { 'approval-rate': 0.95 },
      approvals: ['tech-lead'],
    };

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => metrics,
      getActiveTriggers: () => [],
    });

    await reconciler(policy);
    expect(policy.status?.agents?.[0].currentLevel).toBe(0);
  });

  it('demotes agents on security triggers', async () => {
    const onDemotion = vi.fn();
    const policy = makePolicy();
    policy.status!.agents![0].currentLevel = 1;

    const metrics: AgentMetrics = {
      name: 'agent-1',
      currentLevel: 1,
      totalTasksCompleted: 20,
      metrics: {},
      approvals: [],
    };

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => metrics,
      getActiveTriggers: () => ['security-incident'],
      onDemotion,
    });

    const result = await reconciler(policy);
    expect(result.type).toBe('success');
    expect(policy.status?.agents?.[0].currentLevel).toBe(0);
    expect(onDemotion).toHaveBeenCalledWith('agent-1', 1, 0, 'security-incident');
  });

  it('demotion takes priority over promotion', async () => {
    const policy = makePolicy();
    policy.status!.agents![0].currentLevel = 0;

    const metrics: AgentMetrics = {
      name: 'agent-1',
      currentLevel: 0,
      totalTasksCompleted: 15,
      metrics: { 'approval-rate': 0.95 },
      approvals: ['tech-lead'],
    };

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => metrics,
      getActiveTriggers: () => ['security-incident'],
    });

    await reconciler(policy);
    // Already at 0, demotion to 0 is a no-op but still prevents promotion
    expect(policy.status?.agents?.[0].currentLevel).toBe(0);
  });

  it('succeeds with no agents', async () => {
    const policy = makePolicy();
    policy.status!.agents = [];

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => undefined,
      getActiveTriggers: () => [],
    });

    const result = await reconciler(policy);
    expect(result.type).toBe('success');
  });

  it('skips agents without metrics', async () => {
    const policy = makePolicy();

    const reconciler = createAutonomyReconciler({
      getAgentMetrics: () => undefined,
      getActiveTriggers: () => [],
    });

    const result = await reconciler(policy);
    expect(result.type).toBe('success');
    expect(policy.status?.agents?.[0].currentLevel).toBe(0);
  });
});
