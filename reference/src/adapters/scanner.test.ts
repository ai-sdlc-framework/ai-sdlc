import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMetadataYaml, scanLocalAdapters } from './scanner.js';

describe('parseMetadataYaml', () => {
  it('parses valid YAML into AdapterMetadata', () => {
    const yaml = `
name: my-adapter
displayName: My Adapter
description: Test adapter
version: "1.0.0"
stability: stable
interfaces:
  - SourceControl@v1
owner: team
specVersions:
  - v1alpha1
`;
    const result = parseMetadataYaml(yaml);
    expect(result.name).toBe('my-adapter');
    expect(result.interfaces).toEqual(['SourceControl@v1']);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseMetadataYaml(': bad : yaml :')).toThrow();
  });

  it('throws on empty YAML', () => {
    expect(() => parseMetadataYaml('')).toThrow();
  });
});

describe('scanLocalAdapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adapter-scan-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('scans valid adapter directories', async () => {
    const adapterDir = join(tempDir, 'test-adapter');
    await mkdir(adapterDir);
    await writeFile(
      join(adapterDir, 'metadata.yaml'),
      `
name: test-adapter
displayName: Test Adapter
description: A test adapter
version: "1.0.0"
stability: stable
interfaces:
  - IssueTracker@v1
owner: test-team
specVersions:
  - v1alpha1
`,
    );

    const result = await scanLocalAdapters({ basePath: tempDir });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0].name).toBe('test-adapter');
  });

  it('reports errors for missing metadata.yaml', async () => {
    await mkdir(join(tempDir, 'no-metadata'));
    const result = await scanLocalAdapters({ basePath: tempDir });
    expect(result.adapters).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('skips invalid adapters by default', async () => {
    const adapterDir = join(tempDir, 'bad-adapter');
    await mkdir(adapterDir);
    await writeFile(join(adapterDir, 'metadata.yaml'), 'name: INVALID-NAME\n');

    const result = await scanLocalAdapters({ basePath: tempDir });
    expect(result.adapters).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles missing base directory', async () => {
    const result = await scanLocalAdapters({ basePath: '/nonexistent/path' });
    expect(result.adapters).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
