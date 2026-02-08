import { describe, it, expect } from 'vitest';
import { validate, validateResource } from './validation.js';

const VALID_MINIMAL_PIPELINE = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'Pipeline',
  metadata: { name: 'test-pipeline' },
  spec: {
    triggers: [{ event: 'issue.assigned' }],
    providers: { issueTracker: { type: 'linear' } },
    stages: [{ name: 'implement' }],
  },
};

const VALID_FULL_PIPELINE = {
  ...VALID_MINIMAL_PIPELINE,
  metadata: { name: 'full-pipeline', namespace: 'team-alpha' },
  spec: {
    ...VALID_MINIMAL_PIPELINE.spec,
    routing: {
      complexityThresholds: {
        low: { min: 1, max: 3, strategy: 'fully-autonomous' },
        high: { min: 7, max: 10, strategy: 'human-led' },
      },
    },
  },
  status: {
    phase: 'Running',
    activeStage: 'implement',
    conditions: [{ type: 'Healthy', status: 'True' }],
  },
};

describe('validate()', () => {
  it('accepts a valid minimal Pipeline', () => {
    const result = validate('Pipeline', VALID_MINIMAL_PIPELINE);
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it('accepts a valid full Pipeline with routing and status', () => {
    const result = validate('Pipeline', VALID_FULL_PIPELINE);
    expect(result.valid).toBe(true);
  });

  it('rejects a Pipeline missing stages', () => {
    const doc = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Pipeline',
      metadata: { name: 'bad' },
      spec: {
        triggers: [{ event: 'push' }],
        providers: { git: { type: 'github' } },
      },
    };
    const result = validate('Pipeline', doc);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('rejects a Pipeline with empty stages', () => {
    const doc = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Pipeline',
      metadata: { name: 'bad' },
      spec: {
        triggers: [{ event: 'push' }],
        providers: { git: { type: 'github' } },
        stages: [],
      },
    };
    const result = validate('Pipeline', doc);
    expect(result.valid).toBe(false);
  });

  it('throws for unknown kind', () => {
    expect(() => validate('FakeKind' as never, {})).toThrow();
  });
});

describe('validateResource()', () => {
  it('infers kind from document', () => {
    const result = validateResource(VALID_MINIMAL_PIPELINE);
    expect(result.valid).toBe(true);
  });

  it('rejects a document missing kind', () => {
    const result = validateResource({ apiVersion: 'ai-sdlc.io/v1alpha1', metadata: { name: 'x' } });
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toContain('kind');
  });

  it('rejects unknown kind', () => {
    const result = validateResource({ kind: 'FakeKind' });
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toContain('Unknown resource kind');
  });

  it('rejects null input', () => {
    const result = validateResource(null);
    expect(result.valid).toBe(false);
  });
});
