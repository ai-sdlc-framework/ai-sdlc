import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkFiles, detectModules } from './file-walker.js';

describe('file-walker', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fw-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('walkFiles', () => {
    it('collects .ts files with line counts', async () => {
      await writeFile(join(tmpDir, 'main.ts'), 'const a = 1;\nconst b = 2;\n');
      await writeFile(join(tmpDir, 'util.ts'), 'export function foo() {}\n');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.relativePath).sort()).toEqual(['main.ts', 'util.ts']);

      const mainFile = files.find((f) => f.relativePath === 'main.ts')!;
      expect(mainFile.lineCount).toBe(3); // includes trailing newline split
      expect(mainFile.extension).toBe('.ts');
    });

    it('recurses into subdirectories', async () => {
      await mkdir(join(tmpDir, 'src'));
      await writeFile(join(tmpDir, 'src', 'index.ts'), 'export {};\n');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('src/index.ts');
    });

    it('excludes node_modules by default', async () => {
      await mkdir(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
      await writeFile(join(tmpDir, 'app.ts'), 'const x = 1;\n');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('app.ts');
    });

    it('excludes dist by default', async () => {
      await mkdir(join(tmpDir, 'dist'));
      await writeFile(join(tmpDir, 'dist', 'index.js'), 'var x = 1;');
      await writeFile(join(tmpDir, 'src.ts'), 'const x = 1;\n');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('src.ts');
    });

    it('respects custom exclude patterns', async () => {
      await mkdir(join(tmpDir, 'vendor'));
      await writeFile(join(tmpDir, 'vendor', 'lib.ts'), 'export {};');
      await writeFile(join(tmpDir, 'app.ts'), 'const x = 1;\n');

      const files = await walkFiles(tmpDir, { exclude: ['vendor/**'] });
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('app.ts');
    });

    it('ignores non-code files', async () => {
      await writeFile(join(tmpDir, 'readme.md'), '# Hello\n');
      await writeFile(join(tmpDir, 'data.json'), '{}');
      await writeFile(join(tmpDir, 'app.ts'), 'const x = 1;\n');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(1);
    });

    it('handles empty directories', async () => {
      await mkdir(join(tmpDir, 'empty'));

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(0);
    });

    it('supports multiple code extensions', async () => {
      await writeFile(join(tmpDir, 'a.ts'), 'x');
      await writeFile(join(tmpDir, 'b.tsx'), 'x');
      await writeFile(join(tmpDir, 'c.js'), 'x');
      await writeFile(join(tmpDir, 'd.jsx'), 'x');
      await writeFile(join(tmpDir, 'e.py'), 'x');
      await writeFile(join(tmpDir, 'f.go'), 'x');

      const files = await walkFiles(tmpDir);
      expect(files).toHaveLength(6);
    });
  });

  describe('detectModules', () => {
    it('detects directories with index.ts as modules', async () => {
      await mkdir(join(tmpDir, 'src', 'state'), { recursive: true });
      await writeFile(join(tmpDir, 'src', 'state', 'index.ts'), 'export {};');
      await writeFile(join(tmpDir, 'src', 'state', 'store.ts'), 'export class Store {}');

      const modules = await detectModules(tmpDir);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('state');
      expect(modules[0].path).toBe('src/state');
      expect(modules[0].fileCount).toBe(2);
    });

    it('detects directories with package.json as modules', async () => {
      await mkdir(join(tmpDir, 'packages', 'core'), { recursive: true });
      await writeFile(join(tmpDir, 'packages', 'core', 'package.json'), '{}');
      await writeFile(join(tmpDir, 'packages', 'core', 'main.ts'), 'export {};');

      const modules = await detectModules(tmpDir);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('core');
    });

    it('finds multiple modules', async () => {
      await mkdir(join(tmpDir, 'src', 'a'), { recursive: true });
      await mkdir(join(tmpDir, 'src', 'b'), { recursive: true });
      await writeFile(join(tmpDir, 'src', 'a', 'index.ts'), 'export {};');
      await writeFile(join(tmpDir, 'src', 'b', 'index.ts'), 'export {};');

      const modules = await detectModules(tmpDir);
      expect(modules).toHaveLength(2);
      expect(modules.map((m) => m.name).sort()).toEqual(['a', 'b']);
    });

    it('excludes node_modules', async () => {
      await mkdir(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
      await mkdir(join(tmpDir, 'src'));
      await writeFile(join(tmpDir, 'src', 'index.ts'), 'export {};');

      const modules = await detectModules(tmpDir);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('src');
    });

    it('returns empty for directories without markers', async () => {
      await mkdir(join(tmpDir, 'src', 'utils'), { recursive: true });
      await writeFile(join(tmpDir, 'src', 'utils', 'helper.ts'), 'export {};');

      const modules = await detectModules(tmpDir);
      expect(modules).toHaveLength(0);
    });
  });
});
