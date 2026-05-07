/**
 * Config-browser validator tests — RFC-0023 §9 / AISDLC-178.5 AC#5/AC#6.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  lineForJsonPath,
  validateYaml,
  type SchemaValidator,
  NOOP_SCHEMA_VALIDATOR,
} from './validator.js';

describe('validateYaml — parse layer', () => {
  it('valid YAML with no kind → valid, detectedKind=null', () => {
    const result = validateYaml({ text: 'foo: 1\nbar: 2\n' });
    expect(result.valid).toBe(true);
    expect(result.detectedKind).toBeNull();
    expect(result.issues).toEqual([]);
  });

  it('malformed YAML surfaces a parse-source issue with line number', () => {
    const result = validateYaml({ text: 'foo:\n  - bar\n  - : baz\n' });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].source).toBe('parse');
    expect(result.issues[0].line).toBeGreaterThan(0);
  });

  it('detects `kind:` at the document root', () => {
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nmetadata:\n  name: x\n',
    });
    expect(result.detectedKind).toBe('Pipeline');
  });

  it('treats a kind that is not a string as no-kind', () => {
    const result = validateYaml({ text: 'kind:\n  - not a string\n' });
    expect(result.detectedKind).toBeNull();
  });
});

describe('validateYaml — schema layer', () => {
  it('skips schema validation when no schema validator is provided', () => {
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nspec: {}\n',
    });
    expect(result.valid).toBe(true);
  });

  it('skips schema validation for unknown kind', () => {
    const validator = vi.fn().mockReturnValue([{ message: 'should not run', path: '/' }]);
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Unknown\n',
      schemaValidator: validator as SchemaValidator,
    });
    expect(validator).not.toHaveBeenCalled();
    expect(result.valid).toBe(true);
  });

  it('runs the schema validator when kind is recognised', () => {
    const validator = vi.fn().mockReturnValue([{ message: 'spec is required', path: '/spec' }]);
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nmetadata:\n  name: x\n',
      schemaValidator: validator as SchemaValidator,
    });
    expect(validator).toHaveBeenCalledWith(
      'Pipeline',
      expect.objectContaining({ kind: 'Pipeline' }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toBe('spec is required');
    expect(result.issues[0].source).toBe('schema');
  });

  it('NOOP_SCHEMA_VALIDATOR returns null and never reports issues', () => {
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\n',
      schemaValidator: NOOP_SCHEMA_VALIDATOR,
    });
    expect(result.valid).toBe(true);
  });

  it('issues are sorted by line ascending', () => {
    const validator: SchemaValidator = () => [
      { message: 'late', path: '/spec/late' },
      { message: 'early', path: '/spec/early' },
    ];
    const result = validateYaml({
      text: 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nspec:\n  early: 1\n  late: 2\n',
      schemaValidator: validator,
    });
    const lines = result.issues.map((i) => i.line);
    expect(lines).toEqual([...lines].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe('lineForJsonPath', () => {
  it('returns 1 for the root path', () => {
    expect(lineForJsonPath('foo: 1\n', '/')).toBe(1);
    expect(lineForJsonPath('foo: 1\n', '')).toBe(1);
  });

  it('finds the line for a top-level key', () => {
    expect(lineForJsonPath('foo: 1\nbar: 2\n', '/bar')).toBe(2);
  });

  it('finds the leaf key when the path is nested', () => {
    expect(lineForJsonPath('spec:\n  name: x\n', '/spec/name')).toBe(2);
  });

  it('skips numeric segments (array indices) when picking the key', () => {
    expect(lineForJsonPath('items:\n  - name: a\n  - name: b\n', '/items/1/name')).toBe(2);
  });

  it('returns 1 when the path key cannot be located', () => {
    expect(lineForJsonPath('foo: 1\n', '/missing')).toBe(1);
  });
});
