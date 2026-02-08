import { describe, it, expect } from 'vitest';
import type { AgentRole } from '../core/types.js';
import { validateHandoff, simpleSchemaValidate, type SchemaResolver } from './executor.js';

function makeAgent(name: string, handoffs?: AgentRole['spec']['handoffs']): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      role: 'test',
      goal: 'test goal',
      tools: [],
      skills: [],
      handoffs: handoffs ?? [],
    },
  } as unknown as AgentRole;
}

const schema: Record<string, unknown> = {
  type: 'object',
  required: ['code', 'language'],
  properties: {
    code: { type: 'string' },
    language: { type: 'string' },
    lineCount: { type: 'integer' },
  },
};

const resolver: SchemaResolver = (ref: string) => {
  if (ref === 'code-review-contract') return schema;
  return undefined;
};

describe('simpleSchemaValidate', () => {
  it('valid payload passes', () => {
    const errors = simpleSchemaValidate(schema, { code: 'x', language: 'ts' });
    expect(errors).toHaveLength(0);
  });

  it('missing required field fails', () => {
    const errors = simpleSchemaValidate(schema, { code: 'x' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('language');
  });

  it('wrong type fails', () => {
    const errors = simpleSchemaValidate({ type: 'string' }, 42);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('string');
  });

  it('integer check works', () => {
    const errors = simpleSchemaValidate(
      { type: 'object', properties: { count: { type: 'integer' } } },
      { count: 3.5 },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('integer');
  });

  it('nested properties validated', () => {
    const nested = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    };
    const errors = simpleSchemaValidate(nested, { meta: {} });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toContain('meta');
  });

  it('null value returns error', () => {
    const errors = simpleSchemaValidate({ type: 'object' }, null);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('validateHandoff with schema', () => {
  it('valid payload with schema passes', () => {
    const from = makeAgent('builder', [
      {
        target: 'reviewer',
        trigger: 'build-complete',
        contract: { schema: 'code-review-contract', requiredFields: ['code'] },
      },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, { code: 'fn main(){}', language: 'rust' }, resolver);
    expect(result).toBeNull();
  });

  it('missing required field in schema fails', () => {
    const from = makeAgent('builder', [
      {
        target: 'reviewer',
        trigger: 'build-complete',
        contract: { schema: 'code-review-contract', requiredFields: ['code'] },
      },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, { code: 'x' }, resolver);
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Schema validation');
  });

  it('no schema in contract = pass', () => {
    const from = makeAgent('builder', [
      { target: 'reviewer', trigger: 'done', contract: { schema: '', requiredFields: ['code'] } },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, { code: 'x' }, resolver);
    expect(result).toBeNull();
  });

  it('schema not found = pass (warning, not error)', () => {
    const from = makeAgent('builder', [
      {
        target: 'reviewer',
        trigger: 'done',
        contract: { schema: 'unknown-schema', requiredFields: [] },
      },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, {}, resolver);
    expect(result).toBeNull();
  });

  it('no schema resolver = pass', () => {
    const from = makeAgent('builder', [
      {
        target: 'reviewer',
        trigger: 'done',
        contract: { schema: 'some-schema', requiredFields: [] },
      },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, {});
    expect(result).toBeNull();
  });

  it('multiple artifacts with wrong type', () => {
    const from = makeAgent('builder', [
      {
        target: 'reviewer',
        trigger: 'done',
        contract: { schema: 'code-review-contract', requiredFields: ['code', 'language'] },
      },
    ]);
    const to = makeAgent('reviewer');

    const result = validateHandoff(from, to, { code: 123, language: 'ts' }, resolver);
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Schema validation');
  });
});
