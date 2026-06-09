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
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
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
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
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
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
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
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
    mockedValidateResource.mockReturnValue({
      valid: false,
      errors: undefined,
    });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].errors).toEqual([]);
  });

  // ---------- Silently skips placeholder / null / non-object content ----------
  // These tests verify that validateResource is NOT called for non-resource YAMLs.
  // The guard mirrors config.ts:116.

  it('silently skips placeholder file with no apiVersion or kind (validateResource not called)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['config.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('foo: bar');
    mockedParseYaml.mockReturnValue({ foo: 'bar' });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedValidateResource).not.toHaveBeenCalled();
  });

  it('silently skips non-object YAML content (validateResource not called)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['scalar.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('just a string');
    mockedParseYaml.mockReturnValue('just a string');

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedValidateResource).not.toHaveBeenCalled();
  });

  it('silently skips fully-commented / null YAML content (validateResource not called)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['empty.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue('');
    mockedParseYaml.mockReturnValue(null);

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedValidateResource).not.toHaveBeenCalled();
  });

  it('silently skips object YAML missing apiVersion field (validateResource not called)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['no-apiversion.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: Pipeline');
    // Object has kind but no apiVersion — missing apiVersion branch
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline' });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedValidateResource).not.toHaveBeenCalled();
  });

  it('silently skips object YAML missing kind field (validateResource not called)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['no-kind.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('apiVersion: ai-sdlc.io/v1alpha1');
    // Object has apiVersion but no kind — missing kind branch
    mockedParseYaml.mockReturnValue({ apiVersion: 'ai-sdlc.io/v1alpha1' });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
    expect(mockedValidateResource).not.toHaveBeenCalled();
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
    mockedParseYaml.mockReturnValue({ kind: 'AgentRole', apiVersion: 'ai-sdlc.io/v1alpha1' });
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
      .mockReturnValueOnce({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' })
      .mockReturnValueOnce({ kind: 'AgentRole', apiVersion: 'ai-sdlc.io/v1alpha1' })
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
    mockedParseYaml.mockReturnValue({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' });
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
    mockedParseYaml.mockReturnValue({ kind: 'QualityGate', apiVersion: 'ai-sdlc.io/v1alpha1' });
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

  // ---------- Loader-private / adopter-extension kinds (AISDLC-265) ----------

  it('silently skips loader-private kind MaintainersList (no false-positive warning)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['maintainers.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: MaintainersList');
    mockedParseYaml.mockReturnValue({
      apiVersion: 'ai-sdlc/v1',
      kind: 'MaintainersList',
      maintainers: ['alice', 'bob'],
    });
    // validateResource returns { valid: true, skipped: true } for unknown kinds
    mockedValidateResource.mockReturnValue({ valid: true, skipped: true });

    const results = validateConfigFiles('/some/dir');

    // Skipped files are omitted from results entirely — no false-positive errors
    expect(results).toHaveLength(0);
  });

  it('silently skips adopter-extension kind SoulTrackMap (no false-positive warning)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['soul-tracks.yaml'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReadFileSync.mockReturnValue('kind: SoulTrackMap');
    mockedParseYaml.mockReturnValue({
      apiVersion: 'ai-sdlc/v1',
      kind: 'SoulTrackMap',
      tracks: { 'track:enchantment': 0.85 },
    });
    // validateResource returns { valid: true, skipped: true } for unknown kinds
    mockedValidateResource.mockReturnValue({ valid: true, skipped: true });

    const results = validateConfigFiles('/some/dir');

    expect(results).toHaveLength(0);
  });

  it('processes valid known-kind files alongside skipped loader-private files', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      'pipeline.yaml',
      'maintainers.yaml',
    ] as unknown as ReturnType<typeof readdirSync>);

    mockedReadFileSync
      .mockReturnValueOnce('kind: Pipeline')
      .mockReturnValueOnce('kind: MaintainersList');

    mockedParseYaml
      .mockReturnValueOnce({ kind: 'Pipeline', apiVersion: 'ai-sdlc.io/v1alpha1' })
      .mockReturnValueOnce({ apiVersion: 'ai-sdlc/v1', kind: 'MaintainersList' });

    mockedValidateResource
      .mockReturnValueOnce({ valid: true })
      .mockReturnValueOnce({ valid: true, skipped: true });

    const results = validateConfigFiles('/some/dir');

    // Only the Pipeline result is returned — MaintainersList is silently skipped
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('pipeline.yaml');
    expect(results[0].valid).toBe(true);
  });
});
