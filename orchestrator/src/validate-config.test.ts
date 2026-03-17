import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs before importing the module under test
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock yaml
vi.mock('yaml', () => ({
  parse: vi.fn(),
}));

// Mock @ai-sdlc/reference
vi.mock('@ai-sdlc/reference', () => ({
  validateResource: vi.fn(),
}));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateResource } from '@ai-sdlc/reference';
import { validateConfigFiles } from './validate-config.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedParseYaml = vi.mocked(parseYaml);
const mockedValidateResource = vi.mocked(validateResource);

describe('validateConfigFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------- Directory does not exist ----------

  it('returns an error result when config directory does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    const results = validateConfigFiles('/nonexistent/dir');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('/nonexistent/dir');
    expect(results[0].kind).toBeNull();
    expect(results[0].valid).toBe(false);
    expect(results[0].errors[0].path).toBe('/');
    expect(results[0].errors[0].message).toContain('Config directory not found');
  });

  // ---------- Empty directory ----------

  it('returns empty results when directory has no YAML files', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
  });

  // ---------- Filters non-yaml files ----------

  it('ignores non-YAML files', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      'readme.md',
      'config.json',
      'notes.txt',
    ] as unknown as ReturnType<typeof readdirSync>);

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  // ---------- Skips manifest.yaml ----------

  it('skips manifest.yaml', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['manifest.yaml', 'pipeline.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });
    mockedValidateResource.mockReturnValue({ valid: true });

    const results = validateConfigFiles('/some/dir');

    // Only pipeline.yaml should be processed, not manifest.yaml
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('pipeline.yaml');
  });

  // ---------- Processes both .yaml and .yml ----------

  it('processes both .yaml and .yml files', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['pipeline.yaml', 'agent.yml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });
    mockedValidateResource.mockReturnValue({ valid: true });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(2);
    expect(results[0].file).toBe('pipeline.yaml');
    expect(results[1].file).toBe('agent.yml');
  });

  // ---------- Valid resource ----------

  it('returns valid result for a valid resource', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['pipeline.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
    mockedValidateResource.mockReturnValue({ valid: true });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      file: 'pipeline.yaml',
      kind: 'Pipeline',
      valid: true,
      errors: [],
    });
  });

  // ---------- Invalid resource with errors ----------

  it('returns invalid result with mapped errors for invalid resource', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['bad.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: [
        { path: '/spec/stages', message: 'is required', keyword: 'required' },
        { path: '/metadata/name', message: 'must be a string', keyword: 'type' },
      ],
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('bad.yaml');
    expect(results[0].kind).toBe('Pipeline');
    expect(results[0].valid).toBe(false);
    expect(results[0].errors).toEqual([
      { path: '/spec/stages', message: 'is required' },
      { path: '/metadata/name', message: 'must be a string' },
    ]);
  });

  // ---------- Invalid resource with undefined errors ----------

  it('handles validation result with undefined errors array', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['bad.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: undefined,
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].errors).toEqual([]);
  });

  // ---------- Document without kind ----------

  it('returns null kind for documents without a kind field', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['config.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('foo: bar');
    mockedParseYaml.mockReturnValue({ foo: 'bar' });
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: [{ path: '/', message: 'Missing "kind" field', keyword: 'required' }],
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBeNull();
  });

  // ---------- Non-object parsed YAML (e.g., a plain string) ----------

  it('returns null kind for non-object YAML content', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['scalar.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('just a string');
    mockedParseYaml.mockReturnValue('just a string');
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: [{ path: '/', message: 'not an object', keyword: 'type' }],
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBeNull();
    expect(results[0].valid).toBe(false);
  });

  // ---------- Null parsed YAML ----------

  it('returns null kind for null YAML content', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['empty.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('');
    mockedParseYaml.mockReturnValue(null);
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: [{ path: '/', message: 'empty document', keyword: 'type' }],
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBeNull();
  });

  // ---------- YAML parse error ----------

  it('catches YAML parse errors and returns them in results', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['malformed.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('bad: [unclosed');
    mockedParseYaml.mockImplementation(() => {
      throw new Error('YAML parse error at line 1');
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('malformed.yaml');
    expect(results[0].kind).toBeNull();
    expect(results[0].valid).toBe(false);
    expect(results[0].errors).toEqual([{ path: '/', message: 'YAML parse error at line 1' }]);
  });

  // ---------- readFileSync error ----------

  it('catches file read errors', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['unreadable.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('unreadable.yaml');
    expect(results[0].valid).toBe(false);
    expect(results[0].errors[0].message).toBe('EACCES: permission denied');
  });

  // ---------- Non-Error thrown in catch ----------

  it('handles non-Error thrown values by converting to string', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['throws-string.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockImplementation(() => {
      throw 'string error';
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].errors[0].message).toBe('string error');
  });

  // ---------- fileFilter — matching file ----------

  it('filters to a specific file when fileFilter is provided', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      'pipeline.yaml',
      'agent-role.yaml',
      'quality-gate.yaml',
    ] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('kind: AgentRole');
    mockedParseYaml.mockReturnValue({ kind: 'AgentRole' });
    mockedValidateResource.mockReturnValue({ valid: true });

    const results = validateConfigFiles('/some/dir', 'agent-role.yaml');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('agent-role.yaml');
    expect(results[0].valid).toBe(true);
    // readFileSync should only be called once for the filtered file
    expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
  });

  // ---------- fileFilter — no match ----------

  it('returns error when fileFilter does not match any file', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['pipeline.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);

    const results = validateConfigFiles('/some/dir', 'nonexistent.yaml');

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('nonexistent.yaml');
    expect(results[0].kind).toBeNull();
    expect(results[0].valid).toBe(false);
    expect(results[0].errors[0].message).toBe(
      'File not found in config directory: nonexistent.yaml',
    );
    // Should not attempt to read any files
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  // ---------- Multiple files with mixed results ----------

  it('processes multiple files and returns individual results', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      'pipeline.yaml',
      'agent-role.yaml',
      'broken.yml',
    ] as unknown as ReturnType<typeof readdirSync>);

    mockedReadFileSync
      .mockReturnValueOnce('kind: Pipeline')
      .mockReturnValueOnce('kind: AgentRole')
      .mockReturnValueOnce('invalid yaml');

    mockedParseYaml
      .mockReturnValueOnce({ kind: 'Pipeline' })
      .mockReturnValueOnce({ kind: 'AgentRole' })
      .mockImplementationOnce(() => {
        throw new Error('invalid YAML');
      });

    mockedValidateResource.mockReturnValueOnce({ valid: true }).mockReturnValueOnce({
      valid: false,
      errors: [{ path: '/spec', message: 'missing field', keyword: 'required' }],
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(3);

    // First file: valid
    expect(results[0]).toEqual({
      file: 'pipeline.yaml',
      kind: 'Pipeline',
      valid: true,
      errors: [],
    });

    // Second file: invalid with validation errors
    expect(results[1]).toEqual({
      file: 'agent-role.yaml',
      kind: 'AgentRole',
      valid: false,
      errors: [{ path: '/spec', message: 'missing field' }],
    });

    // Third file: YAML parse error
    expect(results[2]).toEqual({
      file: 'broken.yml',
      kind: null,
      valid: false,
      errors: [{ path: '/', message: 'invalid YAML' }],
    });
  });

  // ---------- validateResource throws ----------

  it('catches errors thrown by validateResource', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['crash.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });
    mockedValidateResource.mockImplementation(() => {
      throw new Error('schema compilation failed');
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].errors[0].message).toBe('schema compilation failed');
  });

  // ---------- FileValidationResult type shape ----------

  it('returns objects conforming to FileValidationResult interface', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['test.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('kind: QualityGate');
    mockedParseYaml.mockReturnValue({ kind: 'QualityGate' });
    mockedValidateResource.mockReturnValue({ valid: true });

    const results = validateConfigFiles('/some/dir');
    const result = results[0];

    // Verify the shape matches FileValidationResult
    expect(result).toHaveProperty('file');
    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
    expect(typeof result.file).toBe('string');
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
