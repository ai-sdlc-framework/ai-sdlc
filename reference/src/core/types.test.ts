import { describe, it, expect } from 'vitest';
import { API_VERSION } from './types.js';
import type { ResourceKind, Pipeline } from './types.js';

describe('API_VERSION', () => {
  it('equals ai-sdlc.io/v1alpha1', () => {
    expect(API_VERSION).toBe('ai-sdlc.io/v1alpha1');
  });
});

describe('ResourceKind', () => {
  it('accepts all 6 kinds', () => {
    const kinds: ResourceKind[] = [
      'Pipeline',
      'AgentRole',
      'QualityGate',
      'AutonomyPolicy',
      'AdapterBinding',
      'DesignSystemBinding',
    ];
    expect(kinds).toHaveLength(6);
  });
});

describe('Pipeline type shape', () => {
  it('constructs a Pipeline with optional status', () => {
    const pipeline: Pipeline = {
      apiVersion: API_VERSION,
      kind: 'Pipeline',
      metadata: { name: 'test' },
      spec: {
        triggers: [{ event: 'push' }],
        providers: { git: { type: 'github' } },
        stages: [{ name: 'build' }],
      },
    };
    expect(pipeline.kind).toBe('Pipeline');
    expect(pipeline.status).toBeUndefined();
  });

  it('constructs a Pipeline with status', () => {
    const pipeline: Pipeline = {
      apiVersion: API_VERSION,
      kind: 'Pipeline',
      metadata: { name: 'test' },
      spec: {
        triggers: [{ event: 'push' }],
        providers: { git: { type: 'github' } },
        stages: [{ name: 'build' }],
      },
      status: {
        phase: 'Running',
        activeStage: 'build',
        conditions: [{ type: 'Healthy', status: 'True' }],
      },
    };
    expect(pipeline.status?.phase).toBe('Running');
  });
});
