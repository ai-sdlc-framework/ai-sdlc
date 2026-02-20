import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseImports, buildModuleGraph } from './dependency-parser.js';
import type { ModuleInfo } from './types.js';

describe('dependency-parser', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dp-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('parseImports', () => {
    it('parses ES import statements', async () => {
      const filePath = join(tmpDir, 'test.ts');
      await writeFile(
        filePath,
        `
import { foo } from './utils.js';
import type { Bar } from '../types.js';
import express from 'express';
`,
      );

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(3);
      expect(imports[0].specifier).toBe('./utils.js');
      expect(imports[0].isExternal).toBe(false);
      expect(imports[1].specifier).toBe('../types.js');
      expect(imports[1].isExternal).toBe(false);
      expect(imports[2].specifier).toBe('express');
      expect(imports[2].isExternal).toBe(true);
    });

    it('parses export-from statements', async () => {
      const filePath = join(tmpDir, 'index.ts');
      await writeFile(
        filePath,
        `
export { foo } from './foo.js';
export type { Bar } from './bar.js';
export * from './baz.js';
`,
      );

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(3);
      expect(imports.map((i) => i.specifier).sort()).toEqual(['./bar.js', './baz.js', './foo.js']);
    });

    it('parses require statements', async () => {
      const filePath = join(tmpDir, 'test.js');
      await writeFile(
        filePath,
        `
const fs = require('node:fs');
const util = require('./util.js');
`,
      );

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(2);
      expect(imports[0].specifier).toBe('node:fs');
      expect(imports[0].isExternal).toBe(true);
      expect(imports[1].specifier).toBe('./util.js');
      expect(imports[1].isExternal).toBe(false);
    });

    it('handles scoped packages', async () => {
      const filePath = join(tmpDir, 'test.ts');
      await writeFile(filePath, `import { ref } from '@ai-sdlc/reference';`);

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe('@ai-sdlc/reference');
      expect(imports[0].isExternal).toBe(true);
    });

    it('deduplicates same specifier', async () => {
      const filePath = join(tmpDir, 'test.ts');
      await writeFile(
        filePath,
        `
import { a } from './foo.js';
export { b } from './foo.js';
`,
      );

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(1);
    });

    it('returns empty for missing file', async () => {
      const imports = await parseImports(join(tmpDir, 'nonexistent.ts'));
      expect(imports).toEqual([]);
    });

    it('includes line numbers', async () => {
      const filePath = join(tmpDir, 'test.ts');
      await writeFile(filePath, `// comment\nimport { foo } from './foo.js';\n`);

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(1);
      expect(imports[0].line).toBe(2);
    });

    it('handles bare side-effect imports', async () => {
      const filePath = join(tmpDir, 'test.ts');
      await writeFile(filePath, `import './polyfill.js';`);

      const imports = await parseImports(filePath);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe('./polyfill.js');
    });
  });

  describe('buildModuleGraph', () => {
    it('builds edges between modules', async () => {
      // Set up two modules: src/a and src/b, where a imports from b
      await mkdir(join(tmpDir, 'src', 'a'), { recursive: true });
      await mkdir(join(tmpDir, 'src', 'b'), { recursive: true });

      await writeFile(join(tmpDir, 'src', 'a', 'index.ts'), `export {};`);
      await writeFile(
        join(tmpDir, 'src', 'a', 'main.ts'),
        `import { thing } from '../b/index.js';`,
      );
      await writeFile(join(tmpDir, 'src', 'b', 'index.ts'), `export const thing = 1;`);

      const modules: ModuleInfo[] = [
        { name: 'a', path: 'src/a', fileCount: 2, dependencies: [], dependents: [] },
        { name: 'b', path: 'src/b', fileCount: 1, dependencies: [], dependents: [] },
      ];

      const files = [
        { path: join(tmpDir, 'src', 'a', 'main.ts'), relativePath: 'src/a/main.ts' },
        { path: join(tmpDir, 'src', 'b', 'index.ts'), relativePath: 'src/b/index.ts' },
      ];

      const graph = await buildModuleGraph(files, modules, tmpDir);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].from).toBe('src/a');
      expect(graph.edges[0].to).toBe('src/b');
      expect(graph.edges[0].importCount).toBe(1);
    });

    it('collects external dependencies', async () => {
      await mkdir(join(tmpDir, 'src'), { recursive: true });
      await writeFile(
        join(tmpDir, 'src', 'app.ts'),
        `import express from 'express';\nimport { z } from 'zod';\nimport { ref } from '@ai-sdlc/reference';\n`,
      );

      const graph = await buildModuleGraph(
        [{ path: join(tmpDir, 'src', 'app.ts'), relativePath: 'src/app.ts' }],
        [{ name: 'src', path: 'src', fileCount: 1, dependencies: [], dependents: [] }],
        tmpDir,
      );

      expect(graph.externalDependencies).toContain('express');
      expect(graph.externalDependencies).toContain('zod');
      expect(graph.externalDependencies).toContain('@ai-sdlc/reference');
    });

    it('detects dependency cycles', async () => {
      // a -> b -> a cycle
      await mkdir(join(tmpDir, 'a'), { recursive: true });
      await mkdir(join(tmpDir, 'b'), { recursive: true });
      await writeFile(join(tmpDir, 'a', 'index.ts'), `import { x } from '../b/index.js';`);
      await writeFile(join(tmpDir, 'b', 'index.ts'), `import { y } from '../a/index.js';`);

      const modules: ModuleInfo[] = [
        { name: 'a', path: 'a', fileCount: 1, dependencies: [], dependents: [] },
        { name: 'b', path: 'b', fileCount: 1, dependencies: [], dependents: [] },
      ];

      const files = [
        { path: join(tmpDir, 'a', 'index.ts'), relativePath: 'a/index.ts' },
        { path: join(tmpDir, 'b', 'index.ts'), relativePath: 'b/index.ts' },
      ];

      const graph = await buildModuleGraph(files, modules, tmpDir);
      expect(graph.cycles.length).toBeGreaterThan(0);
    });

    it('updates module dependencies and dependents', async () => {
      await mkdir(join(tmpDir, 'a'), { recursive: true });
      await mkdir(join(tmpDir, 'b'), { recursive: true });
      await writeFile(join(tmpDir, 'a', 'index.ts'), `import { x } from '../b/index.js';`);
      await writeFile(join(tmpDir, 'b', 'index.ts'), `export const x = 1;`);

      const modules: ModuleInfo[] = [
        { name: 'a', path: 'a', fileCount: 1, dependencies: [], dependents: [] },
        { name: 'b', path: 'b', fileCount: 1, dependencies: [], dependents: [] },
      ];

      const files = [
        { path: join(tmpDir, 'a', 'index.ts'), relativePath: 'a/index.ts' },
        { path: join(tmpDir, 'b', 'index.ts'), relativePath: 'b/index.ts' },
      ];

      const graph = await buildModuleGraph(files, modules, tmpDir);
      const modA = graph.modules.find((m) => m.name === 'a')!;
      const modB = graph.modules.find((m) => m.name === 'b')!;

      expect(modA.dependencies).toContain('b');
      expect(modB.dependents).toContain('a');
    });

    it('handles empty file list', async () => {
      const graph = await buildModuleGraph([], [], tmpDir);
      expect(graph.modules).toEqual([]);
      expect(graph.edges).toEqual([]);
      expect(graph.externalDependencies).toEqual([]);
      expect(graph.cycles).toEqual([]);
    });
  });
});
