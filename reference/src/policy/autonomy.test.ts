import { describe, it, expect } from 'vitest';
import { evaluatePromotion, evaluateDemotion } from './autonomy.js';
import type { AgentMetrics, DemotionConditionContext } from './autonomy.js';
import type { AutonomyPolicy } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

function makePolicy(): AutonomyPolicy {
  return {
    apiVersion: API_VERSION,
    kind: 'AutonomyPolicy',
    metadata: { name: 'test-policy' },
    spec: {
      levels: [
        {
          level: 0,
          name: 'Supervised',
          permissions: { read: ['*'], write: [], execute: [] },
          guardrails: { requireApproval: 'all' },
          monitoring: 'continuous',
        },
        {
          level: 1,
          name: 'Assisted',
          permissions: { read: ['*'], write: ['docs/*'], execute: ['lint'] },
          guardrails: { requireApproval: 'security-critical-only' },
          monitoring: 'real-time-notification',
        },
        {
          level: 2,
          name: 'Autonomous',
          permissions: { read: ['*'], write: ['*'], execute: ['*'] },
          guardrails: { requireApproval: 'none' },
          monitoring: 'audit-log',
        },
      ],
      promotionCriteria: {
        '0-to-1': {
          minimumTasks: 10,
          conditions: [{ metric: 'approvalRate', operator: '>=', threshold: 0.95 }],
          requiredApprovals: ['tech-lead'],
        },
        '1-to-2': {
          minimumTasks: 50,
          conditions: [
            { metric: 'approvalRate', operator: '>=', threshold: 0.98 },
            { metric: 'rollbackRate', operator: '<=', threshold: 0.02 },
          ],
          requiredApprovals: ['tech-lead', 'security-team'],
        },
      },
      demotionTriggers: [
        { trigger: 'security-incident', action: 'demote-to-0', cooldown: '7d' },
        { trigger: 'high-rollback-rate', action: 'demote-one-level', cooldown: '3d' },
      ],
    },
  };
}

function makeAgent(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    name: 'coder-agent',
    currentLevel: 0,
    totalTasksCompleted: 15,
    metrics: { approvalRate: 0.97 },
    approvals: ['tech-lead'],
    ...overrides,
  };
}

describe('evaluatePromotion()', () => {
  it('returns eligible when all criteria met', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent());
    expect(result.eligible).toBe(true);
    expect(result.fromLevel).toBe(0);
    expect(result.toLevel).toBe(1);
    expect(result.unmetConditions).toHaveLength(0);
  });

  it('returns ineligible when tasks below minimum', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent({ totalTasksCompleted: 5 }));
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions).toEqual(
      expect.arrayContaining([expect.stringContaining('Minimum tasks')]),
    );
  });

  it('returns ineligible when metric condition not met', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent({ metrics: { approvalRate: 0.8 } }));
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions).toEqual(
      expect.arrayContaining([expect.stringContaining('approvalRate')]),
    );
  });

  it('returns ineligible when metric is missing', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent({ metrics: {} }));
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions).toEqual(
      expect.arrayContaining([expect.stringContaining('not available')]),
    );
  });

  it('returns ineligible when required approval is missing', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent({ approvals: [] }));
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing approval')]),
    );
  });

  it('returns ineligible when no promotion criteria defined for transition', () => {
    const result = evaluatePromotion(makePolicy(), makeAgent({ currentLevel: 2 }));
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions).toEqual(
      expect.arrayContaining([expect.stringContaining('No promotion criteria')]),
    );
  });

  it('checks multiple conditions for level 1-to-2', () => {
    const agent = makeAgent({
      currentLevel: 1,
      totalTasksCompleted: 60,
      metrics: { approvalRate: 0.99, rollbackRate: 0.01 },
      approvals: ['tech-lead', 'security-team'],
    });
    const result = evaluatePromotion(makePolicy(), agent);
    expect(result.eligible).toBe(true);
    expect(result.fromLevel).toBe(1);
    expect(result.toLevel).toBe(2);
  });
});

describe('evaluateDemotion()', () => {
  it('demotes to level 0 on security incident', () => {
    const agent = makeAgent({ currentLevel: 2 });
    const result = evaluateDemotion(makePolicy(), agent, 'security-incident');
    expect(result.demoted).toBe(true);
    expect(result.fromLevel).toBe(2);
    expect(result.toLevel).toBe(0);
    expect(result.trigger).toBe('security-incident');
  });

  it('demotes one level on high rollback rate', () => {
    const agent = makeAgent({ currentLevel: 2 });
    const result = evaluateDemotion(makePolicy(), agent, 'high-rollback-rate');
    expect(result.demoted).toBe(true);
    expect(result.fromLevel).toBe(2);
    expect(result.toLevel).toBe(1);
  });

  it('does not demote below level 0', () => {
    const agent = makeAgent({ currentLevel: 0 });
    const result = evaluateDemotion(makePolicy(), agent, 'high-rollback-rate');
    expect(result.demoted).toBe(true);
    expect(result.toLevel).toBe(0);
  });

  it('returns no demotion for unknown trigger', () => {
    const agent = makeAgent({ currentLevel: 1 });
    const result = evaluateDemotion(makePolicy(), agent, 'unknown-event');
    expect(result.demoted).toBe(false);
    expect(result.toLevel).toBe(1);
  });

  describe('condition-based demotion', () => {
    function makePolicyWithCondition(): AutonomyPolicy {
      const policy = makePolicy();
      policy.spec.demotionTriggers.push({
        trigger: 'cost-overrun',
        action: 'demote-one-level',
        cooldown: '1d',
        condition: {
          metric: 'budget-utilization',
          operator: '>=',
          threshold: 0.9,
        },
      });
      return policy;
    }

    it('demotes when condition is met', () => {
      const agent = makeAgent({ currentLevel: 2 });
      const conditionCtx: DemotionConditionContext = {
        metrics: { 'budget-utilization': 0.95 },
      };
      const result = evaluateDemotion(
        makePolicyWithCondition(),
        agent,
        'cost-overrun',
        conditionCtx,
      );
      expect(result.demoted).toBe(true);
      expect(result.toLevel).toBe(1);
    });

    it('does not demote when condition is not met', () => {
      const agent = makeAgent({ currentLevel: 2 });
      const conditionCtx: DemotionConditionContext = {
        metrics: { 'budget-utilization': 0.5 },
      };
      const result = evaluateDemotion(
        makePolicyWithCondition(),
        agent,
        'cost-overrun',
        conditionCtx,
      );
      expect(result.demoted).toBe(false);
      expect(result.toLevel).toBe(2);
    });

    it('does not demote when conditionCtx is not provided', () => {
      const agent = makeAgent({ currentLevel: 2 });
      const result = evaluateDemotion(makePolicyWithCondition(), agent, 'cost-overrun');
      expect(result.demoted).toBe(false);
      expect(result.toLevel).toBe(2);
    });

    it('checks window of consecutive values', () => {
      const policy = makePolicy();
      policy.spec.demotionTriggers.push({
        trigger: 'sustained-overrun',
        action: 'demote-one-level',
        cooldown: '1d',
        condition: {
          metric: 'cost-per-run',
          operator: '>',
          threshold: 5,
          window: 3,
        },
      });

      const agent = makeAgent({ currentLevel: 2 });

      // All 3 values exceed threshold → demote
      const ctx1: DemotionConditionContext = {
        metrics: { 'cost-per-run': 10 },
        metricHistory: { 'cost-per-run': [8, 7, 6] },
      };
      expect(evaluateDemotion(policy, agent, 'sustained-overrun', ctx1).demoted).toBe(true);

      // Only 2 of 3 values exceed → no demote
      const ctx2: DemotionConditionContext = {
        metrics: { 'cost-per-run': 10 },
        metricHistory: { 'cost-per-run': [8, 3, 6] },
      };
      expect(evaluateDemotion(policy, agent, 'sustained-overrun', ctx2).demoted).toBe(false);

      // Not enough history → no demote
      const ctx3: DemotionConditionContext = {
        metrics: { 'cost-per-run': 10 },
        metricHistory: { 'cost-per-run': [8, 7] },
      };
      expect(evaluateDemotion(policy, agent, 'sustained-overrun', ctx3).demoted).toBe(false);
    });

    it('trigger without condition still works (backward compatible)', () => {
      const agent = makeAgent({ currentLevel: 2 });
      const result = evaluateDemotion(makePolicy(), agent, 'security-incident');
      expect(result.demoted).toBe(true);
      expect(result.toLevel).toBe(0);
    });
  });
});
