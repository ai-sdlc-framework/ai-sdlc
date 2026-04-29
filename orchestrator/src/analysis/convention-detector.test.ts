import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectConventions,
  detectReactProject,
  enumerateTestLocations,
  loadProjectAliases,
  parseTsConfigAliases,
  parseViteOrWebpackAliases,
} from './convention-detector.js';
import type { FileInfo } from './types.js';

function makeFile(relativePath: string, lineCount = 10): FileInfo {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    lineCount,
    extension: relativePath.split('.').pop()!.replace(/^/, '.'),
  };
}

describe('convention-detector', () => {
  describe('naming conventions', () => {
    it('detects kebab-case naming', async () => {
      const files: FileInfo[] = [
        makeFile('src/user-service.ts'),
        makeFile('src/auth-handler.ts'),
        makeFile('src/data-store.ts'),
        makeFile('src/api-client.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('kebab-case');
      expect(naming!.confidence).toBeGreaterThan(0.5);
    });

    it('detects camelCase naming', async () => {
      const files: FileInfo[] = [
        makeFile('src/userService.ts'),
        makeFile('src/authHandler.ts'),
        makeFile('src/dataStore.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('camelCase');
    });

    it('detects PascalCase naming', async () => {
      const files: FileInfo[] = [
        makeFile('src/UserService.ts'),
        makeFile('src/AuthHandler.ts'),
        makeFile('src/DataStore.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('PascalCase');
    });

    it('detects snake_case naming', async () => {
      const files: FileInfo[] = [
        makeFile('src/user_service.ts'),
        makeFile('src/auth_handler.ts'),
        makeFile('src/data_store.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('snake_case');
    });

    it('ignores index files for naming detection', async () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/user-service.ts'),
        makeFile('src/auth-handler.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming!.pattern).toContain('kebab-case');
    });

    it('strips test suffix before detecting style', async () => {
      const files: FileInfo[] = [
        makeFile('src/user-service.test.ts'),
        makeFile('src/auth-handler.spec.ts'),
        makeFile('src/data-store.ts'),
      ];

      const conventions = await detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming!.pattern).toContain('kebab-case');
    });
  });

  describe('testing conventions', () => {
    it('detects co-located tests', async () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('src/service.test.ts'),
        makeFile('src/handler.ts'),
        makeFile('src/handler.test.ts'),
      ];

      const conventions = await detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('co-located');
    });

    it('detects __tests__ directory convention', async () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('src/__tests__/service.test.ts'),
        makeFile('src/handler.ts'),
        makeFile('src/__tests__/handler.test.ts'),
      ];

      const conventions = await detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('__tests__/');
    });

    it('detects test directory convention', async () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('test/service.test.ts'),
        makeFile('test/handler.test.ts'),
      ];

      const conventions = await detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('test/');
    });

    it('handles no test files', async () => {
      const files: FileInfo[] = [makeFile('src/service.ts'), makeFile('src/handler.ts')];

      const conventions = await detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      // No test files means no testing convention detected
      if (testing) {
        expect(testing.confidence).toBe(0);
      } else {
        expect(testing).toBeUndefined();
      }
    });
  });

  describe('import conventions', () => {
    it('detects barrel re-exports', async () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/state/index.ts'),
        makeFile('src/runners/index.ts'),
        makeFile('src/cli/index.ts'),
        makeFile('src/service.ts'),
      ];

      const conventions = await detectConventions(files);
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toContain('barrel re-exports');
    });

    it('detects relative imports without barrels', async () => {
      const files: FileInfo[] = [makeFile('src/a.ts'), makeFile('src/b.ts')];

      const conventions = await detectConventions(files);
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toBe('Relative imports');
    });
  });

  describe('overall', () => {
    it('returns all convention categories', async () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/user-service.ts'),
        makeFile('src/user-service.test.ts'),
      ];

      const conventions = await detectConventions(files);
      const categories = conventions.map((c) => c.category);
      expect(categories).toContain('naming');
      expect(categories).toContain('testing');
      expect(categories).toContain('imports');
    });

    it('handles empty file list', async () => {
      const conventions = await detectConventions([]);
      // Should return import convention with default
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── AISDLC-80: regression coverage for the three FP classes ──────────

  describe('AISDLC-80 — React naming false-positive', () => {
    let repoDir: string;
    beforeEach(async () => {
      repoDir = await mkdtemp(join(tmpdir(), 'aisdlc-80-react-'));
    });
    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it('does NOT flag PascalCase + camelCase as `mixed` when React is a dep', async () => {
      await writeFile(
        join(repoDir, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } }),
      );

      const files: FileInfo[] = [
        // Components — PascalCase .jsx
        makeFile('src/components/SimpleGrid.jsx'),
        makeFile('src/components/PlayerCard.jsx'),
        makeFile('src/components/GameBoard.jsx'),
        // Hooks — camelCase .js
        makeFile('src/hooks/useSimilarity.js'),
        makeFile('src/hooks/useGameplay.js'),
        // Stores — camelCase .js
        makeFile('src/stores/gameplayStore.js'),
        makeFile('src/stores/similarityStore.js'),
      ];

      const conventions = await detectConventions(files, { repoPath: repoDir });
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).not.toContain('mixed');
      expect(naming!.pattern).toContain('PascalCase + camelCase');
      expect(naming!.pattern).toContain('React');
    });

    it('still flags `mixed` when React PascalCase/camelCase split is broken', async () => {
      await writeFile(
        join(repoDir, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      );

      // Components are kebab-case (wrong) — dual-pattern check should fail.
      const files: FileInfo[] = [
        makeFile('src/components/simple-grid.jsx'),
        makeFile('src/components/player-card.jsx'),
        makeFile('src/hooks/useSimilarity.js'),
        makeFile('src/hooks/useGameplay.js'),
      ];

      const conventions = await detectConventions(files, { repoPath: repoDir });
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).not.toContain('PascalCase + camelCase');
    });

    it('detectReactProject reads dependencies + devDependencies', async () => {
      await writeFile(
        join(repoDir, 'package.json'),
        JSON.stringify({ devDependencies: { react: '^18.0.0' } }),
      );
      expect(await detectReactProject(repoDir)).toBe(true);
    });

    it('detectReactProject returns false when package.json missing', async () => {
      expect(await detectReactProject(repoDir)).toBe(false);
    });

    it('detectReactProject returns false on malformed package.json', async () => {
      await writeFile(join(repoDir, 'package.json'), '{ not valid json');
      expect(await detectReactProject(repoDir)).toBe(false);
    });
  });

  describe('AISDLC-80 — multi-test-directory enumeration', () => {
    it('reports ALL detected test locations, not just one', async () => {
      const files: FileInfo[] = [
        makeFile('tests/unit-thing.test.ts'),
        makeFile('tests/another.test.ts'),
        makeFile('tests/e2e/login.test.ts'),
        makeFile('tests/e2e/checkout.test.ts'),
        makeFile('src/tests/inner.test.ts'),
        makeFile('src/foo.ts'),
        makeFile('src/foo.test.ts'),
      ];

      const conventions = await detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      // Pattern must enumerate every bucket so consumers see the full set.
      expect(testing!.pattern).toContain('tests/');
      expect(testing!.pattern).toContain('tests/e2e/');
      expect(testing!.pattern).toContain('src/tests/');
      expect(testing!.pattern).toContain('co-located');
    });

    it('enumerateTestLocations classifies cypress/ separately from e2e/', async () => {
      const files: FileInfo[] = [
        makeFile('cypress/e2e/login.cy.js'),
        makeFile('cypress/e2e/signup.cy.js'),
        makeFile('e2e/playwright-thing.spec.ts'),
      ];
      const locations = enumerateTestLocations(files);
      const labels = locations.map((l) => l.label);
      expect(labels).toContain('cypress/');
      expect(labels).toContain('e2e/');
    });

    it('enumerateTestLocations buckets __tests__ before generic test/', async () => {
      const files: FileInfo[] = [
        makeFile('src/feature/__tests__/foo.test.ts'),
        makeFile('test/legacy.test.ts'),
      ];
      const locations = enumerateTestLocations(files);
      const labels = locations.map((l) => l.label);
      expect(labels).toContain('__tests__/');
      expect(labels).toContain('test/');
    });

    it('enumerateTestLocations attributes deeper subfolders to specific buckets', async () => {
      const files: FileInfo[] = [
        makeFile('tests/integration/api.test.ts'),
        makeFile('tests/unit/util.test.ts'),
      ];
      const locations = enumerateTestLocations(files);
      const labels = locations.map((l) => l.label);
      expect(labels).toContain('tests/integration/');
      expect(labels).toContain('tests/unit/');
    });

    it('returns empty list when no test files', async () => {
      const locations = enumerateTestLocations([makeFile('src/foo.ts'), makeFile('src/bar.ts')]);
      expect(locations).toEqual([]);
    });
  });

  describe('AISDLC-80 — Vite / TS / webpack path aliases', () => {
    let repoDir: string;
    beforeEach(async () => {
      repoDir = await mkdtemp(join(tmpdir(), 'aisdlc-80-aliases-'));
    });
    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it('parses vite.config.js alias map', async () => {
      const viteConfig = `
        import { defineConfig } from 'vite';
        import path from 'path';
        export default defineConfig({
          resolve: {
            alias: {
              '@components': path.resolve(__dirname, 'src/components'),
              '@engine': path.resolve(__dirname, 'src/engine'),
              '@systems': path.resolve(__dirname, 'src/systems'),
            },
          },
        });
      `;
      await writeFile(join(repoDir, 'vite.config.js'), viteConfig);
      const aliases = await loadProjectAliases(repoDir);
      expect(aliases).toHaveProperty('@components');
      expect(aliases).toHaveProperty('@engine');
      expect(aliases).toHaveProperty('@systems');
    });

    it('parses tsconfig.json compilerOptions.paths with comments + trailing commas', async () => {
      const tsConfig = `{
        // Project-level compiler options
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["src/*"],
            "@components/*": ["src/components/*"], /* with comment */
            "@utils/*": ["src/utils/*"],
          },
        },
      }`;
      await writeFile(join(repoDir, 'tsconfig.json'), tsConfig);
      const aliases = await loadProjectAliases(repoDir);
      expect(aliases['@']).toBe('src/*');
      expect(aliases['@components']).toBe('src/components/*');
      expect(aliases['@utils']).toBe('src/utils/*');
    });

    it('parses webpack.config.js alias map', async () => {
      const webpackConfig = `
        module.exports = {
          resolve: {
            alias: {
              '@app': '/abs/src/app',
              '@lib': '/abs/src/lib',
            },
          },
        };
      `;
      await writeFile(join(repoDir, 'webpack.config.js'), webpackConfig);
      const aliases = await loadProjectAliases(repoDir);
      expect(aliases).toHaveProperty('@app');
      expect(aliases).toHaveProperty('@lib');
    });

    it('parses jsconfig.json paths', async () => {
      const jsConfig = JSON.stringify({
        compilerOptions: { paths: { '@features/*': ['src/features/*'] } },
      });
      await writeFile(join(repoDir, 'jsconfig.json'), jsConfig);
      const aliases = await loadProjectAliases(repoDir);
      expect(aliases['@features']).toBe('src/features/*');
    });

    it('parseTsConfigAliases tolerates malformed JSON without throwing', () => {
      expect(parseTsConfigAliases('not json at all')).toEqual({});
    });

    it('parseViteOrWebpackAliases returns empty map when no alias block', () => {
      expect(parseViteOrWebpackAliases('export default { plugins: [] };')).toEqual({});
    });

    it('detectConventions categorises alias-prefixed imports separately', async () => {
      const viteConfig = `
        export default {
          resolve: {
            alias: {
              '@components': '/src/components',
              '@engine': '/src/engine',
            },
          },
        };
      `;
      await writeFile(join(repoDir, 'vite.config.js'), viteConfig);

      const files: FileInfo[] = [
        makeFile('src/components/Foo.jsx'),
        makeFile('src/engine/render.js'),
        makeFile('src/index.js'),
      ];

      const conventions = await detectConventions(files, { repoPath: repoDir });
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toContain('Path aliases');
      expect(imports!.pattern).toContain('@components');
      expect(imports!.pattern).toContain('@engine');
    });
  });

  // ── AISDLC-80: full Alex-Kline-style synthetic project ───────────────

  describe("AISDLC-80 — synthetic React/Vite project mirroring Alex Kline's repo", () => {
    let repoDir: string;
    beforeEach(async () => {
      repoDir = await mkdtemp(join(tmpdir(), 'aisdlc-80-fixture-'));
      // package.json with React
      await writeFile(
        join(repoDir, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
          devDependencies: { vite: '^5.0.0' },
        }),
      );
      // vite.config.js with the Alex-style aliases
      await writeFile(
        join(repoDir, 'vite.config.js'),
        `
          import { defineConfig } from 'vite';
          import path from 'path';
          export default defineConfig({
            resolve: {
              alias: {
                '@systems': path.resolve(__dirname, 'src/systems'),
                '@engine': path.resolve(__dirname, 'src/engine'),
                '@components': path.resolve(__dirname, 'src/components'),
              },
            },
          });
        `,
      );
      // tsconfig path mapping shadowing the same aliases
      await writeFile(
        join(repoDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@systems/*': ['src/systems/*'],
              '@engine/*': ['src/engine/*'],
              '@components/*': ['src/components/*'],
            },
          },
        }),
      );
      // Need real subdirs for any file ops the detector might do — even
      // though the detector itself doesn't walk the disk for naming, having
      // the dirs makes the fixture self-consistent.
      await mkdir(join(repoDir, 'src/components'), { recursive: true });
      await mkdir(join(repoDir, 'src/hooks'), { recursive: true });
      await mkdir(join(repoDir, 'src/stores'), { recursive: true });
      await mkdir(join(repoDir, 'tests/e2e'), { recursive: true });
      await mkdir(join(repoDir, 'src/tests'), { recursive: true });
    });
    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    it('reports zero false-positives across naming, testing, imports', async () => {
      const files: FileInfo[] = [
        // React components — PascalCase .jsx
        makeFile('src/components/SimpleGrid.jsx'),
        makeFile('src/components/PlayerCard.jsx'),
        makeFile('src/components/GameBoard.jsx'),
        // Hooks — camelCase .js
        makeFile('src/hooks/useSimilarity.js'),
        makeFile('src/hooks/useGameplay.js'),
        // Stores — camelCase .js
        makeFile('src/stores/gameplayStore.js'),
        makeFile('src/stores/similarityStore.js'),
        // Tests across multiple directories
        makeFile('tests/setup.js'),
        makeFile('tests/util.test.js'),
        makeFile('tests/e2e/login.test.js'),
        makeFile('tests/e2e/checkout.test.js'),
        makeFile('src/tests/integration.test.js'),
      ];

      const conventions = await detectConventions(files, { repoPath: repoDir });

      // 1) Naming false positive — gone.
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).not.toContain('mixed');
      expect(naming!.pattern).toContain('PascalCase + camelCase');

      // 2) Testing false positive — gone (full set reported).
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('tests/');
      expect(testing!.pattern).toContain('tests/e2e/');
      expect(testing!.pattern).toContain('src/tests/');

      // 3) Imports false positive — gone (aliases categorised separately).
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toContain('Path aliases');
      expect(imports!.pattern).toContain('@systems');
      expect(imports!.pattern).toContain('@engine');
      expect(imports!.pattern).toContain('@components');
    });
  });
});
