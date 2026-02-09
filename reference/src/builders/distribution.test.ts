import { describe, it, expect } from 'vitest';
import {
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  type BuilderManifest,
} from './distribution.js';
import type { AdapterMetadata } from '../adapters/registry.js';

const VALID_MANIFEST_YAML = `
spec_version: v1alpha1
adapters:
  - name: github-ci
    version: "1.0.0"
  - name: linear-tracker
    version: "0.5.0"
output:
  name: my-distribution
  version: "1.0.0"
`;

const makeAdapter = (name: string, version: string): AdapterMetadata => ({
  name,
  displayName: name,
  description: `${name} adapter`,
  version,
  stability: 'stable',
  interfaces: ['CIPipeline@v1'],
  owner: 'test',
  specVersions: ['v1alpha1'],
});

describe('parseBuilderManifest', () => {
  it('parses valid YAML manifest', () => {
    const manifest = parseBuilderManifest(VALID_MANIFEST_YAML);
    expect(manifest.spec_version).toBe('v1alpha1');
    expect(manifest.adapters).toHaveLength(2);
    expect(manifest.adapters[0].name).toBe('github-ci');
    expect(manifest.output.name).toBe('my-distribution');
  });

  it('throws on invalid YAML', () => {
    expect(() => parseBuilderManifest('not: [valid: yaml: {')).toThrow();
  });

  it('throws when spec_version is missing', () => {
    expect(() =>
      parseBuilderManifest(`
adapters:
  - name: foo
    version: "1.0"
output:
  name: out
  version: "1.0"
`),
    ).toThrow('spec_version');
  });

  it('throws when adapters is not an array', () => {
    expect(() =>
      parseBuilderManifest(`
spec_version: v1alpha1
adapters: not-array
output:
  name: out
  version: "1.0"
`),
    ).toThrow('adapters');
  });

  it('throws when output is missing', () => {
    expect(() =>
      parseBuilderManifest(`
spec_version: v1alpha1
adapters:
  - name: foo
    version: "1.0"
`),
    ).toThrow('output');
  });
});

describe('validateBuilderManifest', () => {
  it('validates a correct manifest', () => {
    const manifest = parseBuilderManifest(VALID_MANIFEST_YAML);
    const result = validateBuilderManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects empty adapters list', () => {
    const manifest: BuilderManifest = {
      spec_version: 'v1alpha1',
      adapters: [],
      output: { name: 'out', version: '1.0' },
    };
    const result = validateBuilderManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one adapter is required');
  });

  it('rejects duplicate adapter names', () => {
    const manifest: BuilderManifest = {
      spec_version: 'v1alpha1',
      adapters: [
        { name: 'dup', version: '1.0' },
        { name: 'dup', version: '2.0' },
      ],
      output: { name: 'out', version: '1.0' },
    };
    const result = validateBuilderManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('rejects missing output.name', () => {
    const manifest: BuilderManifest = {
      spec_version: 'v1alpha1',
      adapters: [{ name: 'a', version: '1.0' }],
      output: { name: '', version: '1.0' },
    };
    const result = validateBuilderManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('output.name'))).toBe(true);
  });
});

describe('buildDistribution', () => {
  it('resolves adapters from builtins', async () => {
    const manifest = parseBuilderManifest(VALID_MANIFEST_YAML);
    const result = await buildDistribution(manifest, {
      builtinAdapters: [makeAdapter('github-ci', '1.0.0'), makeAdapter('linear-tracker', '0.5.0')],
    });
    expect(result.valid).toBe(true);
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved[0].source).toBe('builtin');
    expect(result.resolved[0].versionMatch).toBe(true);
  });

  it('reports error for unknown adapters', async () => {
    const manifest = parseBuilderManifest(VALID_MANIFEST_YAML);
    const result = await buildDistribution(manifest, {
      builtinAdapters: [makeAdapter('github-ci', '1.0.0')],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('linear-tracker'))).toBe(true);
    expect(result.resolved).toHaveLength(1);
  });

  it('warns on version mismatch', async () => {
    const manifest = parseBuilderManifest(VALID_MANIFEST_YAML);
    const result = await buildDistribution(manifest, {
      builtinAdapters: [
        makeAdapter('github-ci', '1.0.0'),
        makeAdapter('linear-tracker', '0.9.0'), // requested 0.5.0
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('version mismatch'))).toBe(true);
    expect(result.resolved[1].versionMatch).toBe(false);
  });

  it('fails fast on invalid manifest', async () => {
    const manifest: BuilderManifest = {
      spec_version: 'v1alpha1',
      adapters: [],
      output: { name: 'out', version: '1.0' },
    };
    const result = await buildDistribution(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one adapter is required');
    expect(result.resolved).toEqual([]);
  });
});
