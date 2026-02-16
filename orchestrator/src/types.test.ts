import { describe, it, expect } from 'vitest';

/**
 * Type-level tests to verify all core, policy, and agent types
 * are re-exported from the orchestrator package.
 */

import type {
  ApiVersion,
  Metadata,
  Condition,
  MetricCondition,
  ResourceKind,
  Stage,
  Gate,
  Permissions,
  Handoff,
  ComplexityThreshold,
  EnforcementLevel,
  RoutingStrategy,
  PipelinePhase,
  MonitoringLevel,
  AdapterInterface,
  ApprovalRequirement,
  ValidationError,
  GateVerdict,
  MemoryTier,
  MemoryEntry,
  MetricRule,
  ExpressionRule,
  GateRule,
} from './types.js';

describe('Type re-exports', () => {
  it('core resource types are accessible', () => {
    const _apiVersion: ApiVersion = 'ai-sdlc.io/v1alpha1';
    const _kind: ResourceKind = 'Pipeline';
    const _level: EnforcementLevel = 'hard-mandatory';
    const _strategy: RoutingStrategy = 'ai-with-review';
    const _phase: PipelinePhase = 'Running';
    const _monitoring: MonitoringLevel = 'continuous';
    const _iface: AdapterInterface = 'IssueTracker';
    const _approval: ApprovalRequirement = 'all';

    expect(_apiVersion).toBe('ai-sdlc.io/v1alpha1');
    expect(_kind).toBe('Pipeline');
    expect(_level).toBe('hard-mandatory');
    expect(_strategy).toBe('ai-with-review');
    expect(_phase).toBe('Running');
    expect(_monitoring).toBe('continuous');
    expect(_iface).toBe('IssueTracker');
    expect(_approval).toBe('all');
  });

  it('policy types are accessible', () => {
    const _verdict: GateVerdict = 'pass';
    const _tier: MemoryTier = 'working';
    expect(_verdict).toBe('pass');
    expect(_tier).toBe('working');
  });

  it('structural types have expected shapes', () => {
    const metadata: Metadata = { name: 'test' };
    expect(metadata.name).toBe('test');

    const condition: Condition = {
      type: 'Ready',
      status: 'True',
      lastTransitionTime: new Date().toISOString(),
    };
    expect(condition.type).toBe('Ready');

    const metricCondition: MetricCondition = {
      metric: 'coverage',
      operator: '>=',
      threshold: 80,
    };
    expect(metricCondition.metric).toBe('coverage');

    const stage: Stage = { name: 'build', agent: 'code-agent' };
    expect(stage.name).toBe('build');

    const gate: Gate = {
      name: 'quality',
      enforcement: 'hard-mandatory',
      rule: { metric: 'coverage', operator: '>=', threshold: 80 },
    };
    expect(gate.name).toBe('quality');

    const permissions: Permissions = {
      read: ['**'],
      write: ['src/**'],
      execute: ['test'],
    };
    expect(permissions.read).toContain('**');
  });

  it('validation error type has expected shape', () => {
    const err: ValidationError = {
      path: '/spec/stages/0',
      message: 'missing required field',
      keyword: 'required',
    };
    expect(err.path).toBe('/spec/stages/0');
    expect(err.message).toBe('missing required field');
    expect(err.keyword).toBe('required');
  });

  it('complex union types compile', () => {
    const metricRule: GateRule = {
      metric: 'coverage',
      operator: '>=',
      threshold: 80,
    };
    expect((metricRule as MetricRule).metric).toBe('coverage');

    const exprRule: GateRule = {
      expression: 'ctx.coverage > 80',
    };
    expect((exprRule as ExpressionRule).expression).toBe('ctx.coverage > 80');
  });

  it('agent memory types compile', () => {
    const entry: MemoryEntry = {
      id: 'entry-1',
      tier: 'working',
      key: 'test',
      value: 'data',
      createdAt: new Date().toISOString(),
    };
    expect(entry.key).toBe('test');
    expect(entry.tier).toBe('working');
  });

  it('handoff type compiles', () => {
    const handoff: Handoff = {
      target: 'review-agent',
      trigger: 'complexity > 5',
    };
    expect(handoff.target).toBe('review-agent');
  });

  it('complexity threshold type compiles', () => {
    const threshold: ComplexityThreshold = {
      min: 1,
      max: 3,
      strategy: 'fully-autonomous',
    };
    expect(threshold.strategy).toBe('fully-autonomous');
  });
});
