/**
 * AISDLC-575 — unit tests for the trusted `@ai-sdlc/orchestrator` runtime
 * resolver used by `cli-attestation verify`.
 *
 * Mirrors the fixture style of `ai-sdlc-plugin/scripts/verify-attestation.test.mjs`
 * (which exercises the equivalent plugin-side resolver end-to-end via
 * subprocess): here we test the pipeline-cli TS port directly, in-process,
 * covering the same four properties AISDLC-575's acceptance criteria call
 * out — trusted resolution succeeds, repoRoot-anchored candidates are
 * rejected, stale versions are rejected, and total absence fails closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAttestationRuntime, TrustedRuntimeResolutionError } from './verify-runtime.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  delete process.env['CLAUDE_PLUGIN_DIR'];
  delete process.env['CLAUDE_PLUGIN_ROOT'];
}

function writeFixtureRuntime(dir: string, version = '0.19.0'): void {
  const distDir = join(dir, 'node_modules', '@ai-sdlc', 'orchestrator', 'dist', 'runtime');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@ai-sdlc', 'orchestrator', 'package.json'),
    JSON.stringify({ name: '@ai-sdlc/orchestrator', version }),
  );
  writeFileSync(join(distDir, 'attestations.js'), "export const MARKER = 'trusted-fixture';\n");
}

describe('verify-runtime — trusted @ai-sdlc/orchestrator resolution (AISDLC-575)', () => {
  let base: string;

  beforeEach(() => {
    resetEnv();
    base = mkdtempSync(join(tmpdir(), 'verify-runtime-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolves a trusted runtime from $CLAUDE_PLUGIN_ROOT, outside repoRoot', async () => {
    const pluginDir = join(base, 'plugin');
    writeFixtureRuntime(pluginDir);
    process.env['CLAUDE_PLUGIN_ROOT'] = pluginDir;

    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    const mod = (await loadAttestationRuntime(repoRoot)) as { MARKER: string };
    expect(mod.MARKER).toBe('trusted-fixture');
  });

  it('rejects a candidate that resolves inside repoRoot, even via $CLAUDE_PLUGIN_ROOT misconfiguration', async () => {
    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    // Misconfigured: CLAUDE_PLUGIN_ROOT points AT the untrusted checkout.
    writeFixtureRuntime(repoRoot);
    process.env['CLAUDE_PLUGIN_ROOT'] = repoRoot;

    await expect(loadAttestationRuntime(repoRoot)).rejects.toThrow(TrustedRuntimeResolutionError);
  });

  it('rejects an installed copy older than the minimum version, even from a trusted location', async () => {
    const pluginDir = join(base, 'plugin');
    writeFixtureRuntime(pluginDir, '0.13.9');
    process.env['CLAUDE_PLUGIN_ROOT'] = pluginDir;

    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    await expect(loadAttestationRuntime(repoRoot)).rejects.toThrow(/too old/);
  });

  it('fails closed with adopter-actionable guidance when no trusted runtime exists anywhere', async () => {
    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    let error: unknown;
    try {
      await loadAttestationRuntime(repoRoot);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TrustedRuntimeResolutionError);
    expect((error as Error).message).toMatch(/TRUSTED/);
    expect((error as Error).message).toMatch(/npm install @ai-sdlc\/orchestrator/);
  });
});

/**
 * AISDLC-575 test-reviewer MAJOR-1 finding: none of the tests above exercise
 * the `nodeModulesWalkUp` candidate — the branch used when NEITHER
 * `CLAUDE_PLUGIN_DIR` nor `CLAUDE_PLUGIN_ROOT` is set. This is the exact
 * mechanism that makes the plugin-less, no-monorepo "npm install
 * @ai-sdlc/orchestrator as a sibling dependency" scenario work (AC4).
 *
 * `loadAttestationRuntime`'s walk-up candidate is anchored on THIS MODULE's
 * own on-disk location (`dirname(fileURLToPath(import.meta.url))`), which is
 * always this actual checkout's `pipeline-cli/src/attestation/` (or
 * `dist/attestation/`) directory — calling it in-process can never exercise
 * a *different* ancestor `node_modules` layout without either (a) writing
 * into this real repo's ancestor directories (destructive, and would
 * accidentally shadow the real workspace `@ai-sdlc/orchestrator` package for
 * every other test in the suite), or (b) making the module resolve from a
 * location we control.
 *
 * These tests take approach (b): copy the module's own SOURCE FILE (self-
 * contained — only `node:fs`/`node:path`/`node:url` imports, verified by the
 * header comment above) into a synthetic install tree inside a fresh
 * `mkdtemp` directory, then dynamically `import()` that COPY. Since
 * `import.meta.url` is resolved per-module-instance from the URL it was
 * imported from — not baked in at compile time — the copy's walk-up starts
 * at the synthetic directory we constructed, giving us full hermetic control
 * over the ancestor `node_modules` layout without touching the real
 * ancestor filesystem at all (mkdtemp + rmSync only).
 */
describe('verify-runtime — bare node_modules walk-up, no CLAUDE_PLUGIN_* env set (AISDLC-575 AC4)', () => {
  let base: string;
  let moduleSourcePath: string;

  beforeEach(() => {
    resetEnv();
    base = mkdtempSync(join(tmpdir(), 'verify-runtime-walkup-'));
    moduleSourcePath = new URL('./verify-runtime.ts', import.meta.url).pathname;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  /**
   * Copies `verify-runtime.ts` to `<installRoot>/some/nested/module.ts` and
   * returns its dynamically-imported module instance. `node_modules` laid
   * out under `installRoot/some/` (i.e. TWO ancestor levels above the copy)
   * is therefore reachable by the walk-up, matching the real module's own
   * `src/attestation/` depth relative to a hypothetical package root.
   */
  async function importWalkUpCopy(installRoot: string): Promise<{
    loadAttestationRuntime: typeof loadAttestationRuntime;
    TrustedRuntimeResolutionError: typeof TrustedRuntimeResolutionError;
  }> {
    const nestedDir = join(installRoot, 'some', 'nested');
    mkdirSync(nestedDir, { recursive: true });
    const copyPath = join(
      nestedDir,
      `verify-runtime-copy-${Math.random().toString(36).slice(2)}.ts`,
    );
    writeFileSync(copyPath, readFileSync(moduleSourcePath, 'utf-8'));
    return (await import(pathToFileURL(copyPath).href)) as {
      loadAttestationRuntime: typeof loadAttestationRuntime;
      TrustedRuntimeResolutionError: typeof TrustedRuntimeResolutionError;
    };
  }

  it('resolves a trusted runtime purely via node_modules walk-up when no plugin env var is set', async () => {
    const installRoot = mkdtempSync(join(base, 'install-'));
    // node_modules sits at `<installRoot>/some/` — an ancestor of the copied
    // module at `<installRoot>/some/nested/verify-runtime-copy-*.ts`.
    writeFixtureRuntime(join(installRoot, 'some'));

    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    const mod = await importWalkUpCopy(installRoot);
    const runtime = (await mod.loadAttestationRuntime(repoRoot)) as { MARKER: string };
    expect(runtime.MARKER).toBe('trusted-fixture');
  });

  it('refuses an orchestrator below the [0,19,0] floor even when found purely via walk-up', async () => {
    const installRoot = mkdtempSync(join(base, 'install-'));
    writeFixtureRuntime(join(installRoot, 'some'), '0.18.9');

    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    const mod = await importWalkUpCopy(installRoot);
    await expect(mod.loadAttestationRuntime(repoRoot)).rejects.toThrow(/too old/);
  });

  it('fails closed when the walk-up layout has no orchestrator installed anywhere', async () => {
    const installRoot = mkdtempSync(join(base, 'install-'));
    // No node_modules written under installRoot at all.

    const repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });

    const mod = await importWalkUpCopy(installRoot);
    await expect(mod.loadAttestationRuntime(repoRoot)).rejects.toThrow(
      mod.TrustedRuntimeResolutionError,
    );
  });
});
