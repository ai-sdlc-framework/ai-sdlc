/**
 * AISDLC-1296: the fixture is a pnpm workspace (packages a and b) whose root test exits 1,
 * and b imports the build output of a; it proves pnpm, the build and the package scope.
 *
 * AISDLC-1291 AC-6 — gated integration test for the fetch + run container pair.
 *
 * A fixture repository with a pnpm lockfile, one dependency that ships a native
 * binary (esbuild) and one passing test must yield upstreamSuitePassed and
 * newTestsPassed for a diff that adds a passing test. Runs only when
 * `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`, Docker is available and the host has
 * network plus pnpm (it generates the lockfile); otherwise skipped.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_CONFIG, runSandbox } from './sandbox-runner.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

function haveTool(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const ENABLED =
  process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1' &&
  haveTool('docker', ['version']) &&
  haveTool('pnpm', ['--version']);

describe.skipIf(!ENABLED)('fetch container + run container (AISDLC-1291 AC-6)', () => {
  it('runs a native-binary dependency from the prepared tree', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-int-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify(
          {
            name: 'fetch-fixture',
            version: '1.0.0',
            private: true,
            // The root test cannot pass: only the per-package scope can.
            scripts: { build: 'pnpm -r build', test: 'exit 1' },
            devDependencies: { esbuild: '0.24.2', 'gyp-fixture': 'file:./gyp-fixture' },
            pnpm: { onlyBuiltDependencies: ['gyp-fixture'] },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - a\n  - b\n');
      // AISDLC-1294: an install script that runs node-gyp needs an executable /tmp in the fetch container.
      mkdirSync(join(dir, 'gyp-fixture'));
      writeFileSync(
        join(dir, 'gyp-fixture', 'package.json'),
        JSON.stringify({
          name: 'gyp-fixture',
          version: '1.0.0',
          scripts: { install: 'node-gyp --version' },
        }),
      );
      // Package a builds dist/; package b imports that build output (AISDLC-1296).
      mkdirSync(join(dir, 'a', 'test'), { recursive: true });
      mkdirSync(join(dir, 'b', 'test'), { recursive: true });
      writeFileSync(
        join(dir, 'a', 'package.json'),
        JSON.stringify({
          name: 'pkg-a',
          version: '1.0.0',
          scripts: {
            build:
              "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js','module.exports=42')\"",
            test: 'node --test test/',
          },
        }),
      );
      writeFileSync(
        join(dir, 'b', 'package.json'),
        JSON.stringify({
          name: 'pkg-b',
          version: '1.0.0',
          scripts: { test: 'node --test test/' },
        }),
      );
      // Executes the native esbuild binary: fails if the prepared tree is not runnable.
      writeFileSync(
        join(dir, 'a', 'test', 'a.test.js'),
        "const t=require('node:test');const a=require('node:assert');\n" +
          "t('native binary runs',()=>{a.ok(require('esbuild').transformSync('let x=1',{}).code.includes('let x'));});\n",
      );
      writeFileSync(
        join(dir, 'b', 'test', 'b.test.js'),
        "const t=require('node:test');const a=require('node:assert');\n" +
          "t('imports the build of a',()=>{a.strictEqual(require('../../a/dist/index.js'),42);});\n",
      );
      execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: dir });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'],
        { cwd: dir },
      );
      const baseTree = mkdtempSync(join(tmpdir(), 'fetch-int-base-'));
      const tarball = execFileSync('git', ['-C', dir, 'archive', '--format=tar', 'HEAD']);
      execFileSync('tar', ['-x', '-C', baseTree], { input: tarball });
      execFileSync('chmod', ['-R', 'a+rX', baseTree]);
      const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
      const diff =
        'diff --git a/b/test/c.test.js b/b/test/c.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/b/test/c.test.js\n@@ -0,0 +1,2 @@\n' +
        "+const t=require('node:test');\n+t('added passes',()=>{});\n";

      const result = await runSandbox({
        prNumber: 1,
        prDiff: diff,
        upstreamMainRef: sha,
        config: DEFAULT_SANDBOX_CONFIG,
        workDir: dir,
        baseTreeDir: baseTree,
      });
      removeFixtureDir(baseTree);
      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(true);
        expect(result.differentialTest.newTestsPassed).toBe(true);
      }
    } finally {
      removeFixtureDir(dir);
    }
  });
});
