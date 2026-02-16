import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeCodebase } from './analyzer.js';

describe('analyzer (facade)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'analyzer-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('produces a CodebaseProfile from a simple codebase', async () => {
    // Create a small codebase
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'index.ts'), `export { foo } from './foo.js';\n`);
    await writeFile(join(tmpDir, 'src', 'foo.ts'), `export function foo() { return 42; }\n`);
    await writeFile(join(tmpDir, 'src', 'bar.ts'), `import { foo } from './foo.js';\nconsole.log(foo());\n`);

    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: ['node_modules/**', '.git/**'],
    });

    expect(profile.repoPath).toBe(tmpDir);
    expect(profile.filesCount).toBe(3);
    expect(profile.score).toBeGreaterThanOrEqual(1);
    expect(profile.score).toBeLessThanOrEqual(10);
    expect(profile.analyzedAt).toBeDefined();
    expect(Array.isArray(profile.conventions)).toBe(true);
    expect(Array.isArray(profile.hotspots)).toBe(true);
    expect(Array.isArray(profile.architecturalPatterns)).toBe(true);
    expect(profile.moduleGraph).toBeDefined();
  });

  it('detects modules with index files', async () => {
    await mkdir(join(tmpDir, 'src', 'state'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'state', 'index.ts'), `export {};\n`);
    await writeFile(join(tmpDir, 'src', 'state', 'store.ts'), `export class Store {}\n`);
    await mkdir(join(tmpDir, 'src', 'runners'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'runners', 'index.ts'), `export {};\n`);
    await writeFile(join(tmpDir, 'src', 'runners', 'claude.ts'), `export class Runner {}\n`);

    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: ['node_modules/**', '.git/**'],
    });

    expect(profile.modulesCount).toBeGreaterThanOrEqual(2);
  });

  it('handles empty directory', async () => {
    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: [],
    });

    expect(profile.filesCount).toBe(0);
    expect(profile.modulesCount).toBe(0);
    expect(profile.score).toBeGreaterThanOrEqual(1);
  });

  it('collects external dependencies', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(
      join(tmpDir, 'src', 'app.ts'),
      `import express from 'express';\nimport { z } from 'zod';\n`,
    );

    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: ['node_modules/**', '.git/**'],
    });

    expect(profile.dependencyCount).toBeGreaterThanOrEqual(2);
    expect(profile.moduleGraph.externalDependencies).toContain('express');
    expect(profile.moduleGraph.externalDependencies).toContain('zod');
  });

  it('respects exclude patterns', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'vendor'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'app.ts'), `const x = 1;\n`);
    await writeFile(join(tmpDir, 'vendor', 'lib.ts'), `const y = 2;\n`);

    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: ['node_modules/**', '.git/**', 'vendor/**'],
    });

    expect(profile.filesCount).toBe(1);
  });

  it('produces conventions list', async () => {
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'user-service.ts'), `export {};\n`);
    await writeFile(join(tmpDir, 'src', 'auth-handler.ts'), `export {};\n`);
    await writeFile(join(tmpDir, 'src', 'user-service.test.ts'), `it('works', () => {});\n`);

    const profile = await analyzeCodebase({
      repoPath: tmpDir,
      exclude: ['node_modules/**', '.git/**'],
    });

    expect(profile.conventions.length).toBeGreaterThan(0);
    const categories = profile.conventions.map((c) => c.category);
    expect(categories).toContain('naming');
  });
});
