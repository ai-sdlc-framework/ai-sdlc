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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
