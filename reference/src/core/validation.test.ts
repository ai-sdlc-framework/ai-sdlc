import { describe, it, expect } from 'vitest';
import { validate, validateResource, formatValidationErrors } from './validation.js';

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

describe('formatValidationErrors()', () => {
  it('collapses oneOf branch errors into a single message', () => {
    const rawErrors = [
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'metric'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/0/required' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'tool'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/1/required' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'reviewer'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/2/required' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'docs'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/3/required' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'provenance'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/4/required' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'expression'", keyword: 'required', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf/5/required' },
      { instancePath: '/spec/gates/0/rule', message: 'must match exactly one schema in oneOf', keyword: 'oneOf', schemaPath: '#/properties/spec/properties/gates/items/properties/rule/oneOf' },
    ];

    const result = formatValidationErrors(rawErrors);
    expect(result).toHaveLength(1);
    expect(result[0].keyword).toBe('oneOf');
    expect(result[0].path).toBe('/spec/gates/0/rule');
    expect(result[0].message).toContain('must match exactly one');
  });

  it('passes through non-oneOf errors unchanged', () => {
    const rawErrors = [
      { instancePath: '/metadata/name', message: 'must be string', keyword: 'type', schemaPath: '#/properties/metadata/properties/name/type' },
      { instancePath: '/spec', message: "must have required property 'stages'", keyword: 'required', schemaPath: '#/properties/spec/required' },
    ];

    const result = formatValidationErrors(rawErrors);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe('must be string');
    expect(result[1].message).toContain('stages');
  });

  it('handles empty error array', () => {
    expect(formatValidationErrors([])).toEqual([]);
  });

  it('handles mixed oneOf and non-oneOf errors', () => {
    const rawErrors = [
      { instancePath: '/metadata/name', message: 'must be string', keyword: 'type', schemaPath: '#/properties/metadata/properties/name/type' },
      { instancePath: '/spec/gates/0/rule', message: "must have required property 'metric'", keyword: 'required', schemaPath: '#/oneOf/0/required' },
      { instancePath: '/spec/gates/0/rule', message: 'must match exactly one schema in oneOf', keyword: 'oneOf', schemaPath: '#/oneOf' },
    ];

    const result = formatValidationErrors(rawErrors);
    expect(result).toHaveLength(2);
    expect(result[0].keyword).toBe('type');
    expect(result[1].keyword).toBe('oneOf');
  });
});
