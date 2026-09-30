import { describe, it, expect, beforeEach } from 'vitest';
import { buildRepoMap, formatRepoMapForPrompt } from './repo-map-builder';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('RepoMapBuilder', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should build repo map with basic structure', () => {
    // Create test structure
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');

    const map = buildRepoMap(tmpDir);

    expect(map.version).toBe('1.0');
    expect(map.rootPath).toBe(tmpDir);
    expect(map.metadata.totalFiles).toBeGreaterThan(0);
    expect(map.structure.length).toBeGreaterThan(0);
  });

  it('should ignore node_modules', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'huge-lib.js'), 'export {}');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const map = buildRepoMap(tmpDir);

    const hasNodeModules = map.structure.some((n) => n.path.includes('node_modules'));
    expect(hasNodeModules).toBe(false);
  });

  it('should detect TypeScript convention', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');

    const map = buildRepoMap(tmpDir);

    expect(map.conventions).toContain('TypeScript');
  });

  it('should format repo map for prompt', () => {
    const map = buildRepoMap(tmpDir);
    const prompt = formatRepoMapForPrompt(map);

    expect(prompt).toContain('## Repository Structure Map');
    expect(prompt).toContain('Metadata');
    expect(prompt).toContain('Conventions');
  });
});
