/**
 * Tests for the `ai-sdlc doctor` check registry (AISDLC-578).
 *
 * Every fixture uses `mkdtempSync` under `os.tmpdir()` — never a shared
 * `/tmp` marker path — and is cleaned up in `afterEach`
 * (see feedback_shared_tmp_marker_dir_pollution.md). All subprocess calls
 * (`node ... --print`, `npm view`, `bash install-runtime-deps.sh`) are
 * driven through a stubbed `runCommand` — no real network, no real `gh`
 * or `npm` process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DOCTOR_CHECKS,
  resolvePluginDir,
  resolvePluginInstall,
  describeResolvedPluginInstall,
  checkPluginVersion,
  checkRuntimeDepsPins,
  fixRuntimeDepsPins,
  checkManifestsAgree,
  fixManifestsAgree,
  checkPluginInstallAmbiguity,
  checkAttestationGovernanceCheck,
  checkMarketplaceCatalogDrift,
  checkNpmDistTagReachability,
  runDoctorChecks,
  runDoctorFixes,
  summarizeDoctorResults,
  renderFullDoctorReport,
  type DoctorCheckAdapters,
  type DoctorRunContext,
} from './doctor-checks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-doctor-checks-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A hermetic adapter set backed by the real fs under `tmpDir`, with an injectable runCommand/env/home. */
function makeAdapters(overrides: Partial<DoctorCheckAdapters> = {}): DoctorCheckAdapters {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf-8');
    },
    listDir: () => [],
    homeDir: () => join(tmpDir, '__home__'),
    env: {},
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    ...overrides,
  };
}

function makeCtx(adapters: DoctorCheckAdapters, projectDir = tmpDir): DoctorRunContext {
  return { projectDir, adapters };
}

function writePluginManifests(
  pluginDir: string,
  opts: {
    rootRuntimeDeps?: Record<string, string>;
    nestedRuntimeDeps?: Record<string, string>;
    rootVersion?: string;
    nestedVersion?: string;
    withHooksScript?: boolean;
    withStaleScript?: boolean;
  } = {},
): void {
  const {
    rootRuntimeDeps = {},
    nestedRuntimeDeps,
    rootVersion = '1.0.0',
    nestedVersion,
    withHooksScript = false,
    withStaleScript = false,
  } = opts;
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  mkdirSync(join(pluginDir, 'scripts'), { recursive: true });

  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ version: rootVersion, runtimeDependencies: rootRuntimeDeps }),
  );
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      version: nestedVersion ?? rootVersion,
      runtimeDependencies: nestedRuntimeDeps ?? rootRuntimeDeps,
    }),
  );
  if (withHooksScript) {
    writeFileSync(join(pluginDir, 'hooks', 'check-plugin-version.js'), '// fake\n');
  }
  if (withStaleScript) {
    writeFileSync(join(pluginDir, 'scripts', 'check-stale-runtime-deps.mjs'), '// fake\n');
  }
}

// ── resolvePluginDir ───────────────────────────────────────────────────

describe('resolvePluginDir', () => {
  it('returns undefined when no candidate has a plugin.json', () => {
    const ctx = makeCtx(makeAdapters());
    expect(resolvePluginDir(ctx)).toBeUndefined();
  });

  it('resolves CLAUDE_PLUGIN_ROOT first when set and valid', () => {
    const envRoot = join(tmpDir, 'env-plugin');
    writePluginManifests(envRoot);
    const ctx = makeCtx(makeAdapters({ env: { CLAUDE_PLUGIN_ROOT: envRoot } }));
    expect(resolvePluginDir(ctx)).toBe(envRoot);
  });

  it('falls back to <projectDir>/ai-sdlc-plugin', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir);
    const ctx = makeCtx(makeAdapters());
    expect(resolvePluginDir(ctx)).toBe(pluginDir);
  });

  it('falls back to <projectDir>/node_modules/ai-sdlc-plugin', () => {
    const pluginDir = join(tmpDir, 'node_modules', 'ai-sdlc-plugin');
    writePluginManifests(pluginDir);
    const ctx = makeCtx(makeAdapters());
    expect(resolvePluginDir(ctx)).toBe(pluginDir);
  });

  it('scans the marketplace cache, picking the SEMVER-highest version dir (not lexical)', () => {
    const homeDir = join(tmpDir, 'home');
    const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
    const v1 = join(cacheRoot, 'acme-marketplace', 'ai-sdlc', '0.1.0');
    const v2 = join(cacheRoot, 'acme-marketplace', 'ai-sdlc', '0.2.0');
    writePluginManifests(v1);
    writePluginManifests(v2);

    const ctx = makeCtx(
      makeAdapters({
        homeDir: () => homeDir,
        listDir: (p) => {
          if (p === cacheRoot) return ['acme-marketplace'];
          if (p === join(cacheRoot, 'acme-marketplace', 'ai-sdlc')) return ['0.1.0', '0.2.0'];
          return [];
        },
      }),
    );
    expect(resolvePluginDir(ctx)).toBe(v2);
  });

  it('AISDLC-586 regression: picks 0.18.0 over 0.9.0 (lexical sort would pick 0.9.0 since "9">"1")', () => {
    const homeDir = join(tmpDir, 'home');
    const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
    const stale = join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc', '0.9.0');
    const current = join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc', '0.18.0');
    writePluginManifests(stale, { rootVersion: '0.9.2' });
    writePluginManifests(current, { rootVersion: '0.18.0' });

    const ctx = makeCtx(
      makeAdapters({
        homeDir: () => homeDir,
        listDir: (p) => {
          if (p === cacheRoot) return ['ai-sdlc-local'];
          if (p === join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc')) return ['0.9.0', '0.18.0'];
          return [];
        },
      }),
    );

    const install = resolvePluginInstall(ctx);
    expect(install?.path).toBe(current);
    expect(install?.version).toBe('0.18.0');
    expect(install?.source).toBe('marketplace');
  });

  it('AISDLC-586: prefers the marketplace install over a repo-local dev checkout that shares a project root', () => {
    const homeDir = join(tmpDir, 'home');
    const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
    const marketplaceDir = join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc', '0.18.0');
    writePluginManifests(marketplaceDir, { rootVersion: '0.18.0' });

    const repoLocalDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(repoLocalDir, { rootVersion: '0.9.2' });

    const ctx = makeCtx(
      makeAdapters({
        homeDir: () => homeDir,
        listDir: (p) => {
          if (p === cacheRoot) return ['ai-sdlc-local'];
          if (p === join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc')) return ['0.18.0'];
          return [];
        },
      }),
    );

    const install = resolvePluginInstall(ctx);
    expect(install?.source).toBe('marketplace');
    expect(install?.path).toBe(marketplaceDir);
  });

  it('AISDLC-586: adopter node_modules install is audited when no env/marketplace candidate exists', () => {
    const pluginDir = join(tmpDir, 'node_modules', 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootVersion: '1.5.0' });
    const ctx = makeCtx(makeAdapters());
    const install = resolvePluginInstall(ctx);
    expect(install?.source).toBe('node_modules');
    expect(install?.path).toBe(pluginDir);
    expect(install?.version).toBe('1.5.0');
  });

  it('AISDLC-586: CLAUDE_PLUGIN_ROOT is reported with source "env" and its version', () => {
    const envRoot = join(tmpDir, 'env-plugin');
    writePluginManifests(envRoot, { rootVersion: '0.21.0' });
    const ctx = makeCtx(makeAdapters({ env: { CLAUDE_PLUGIN_ROOT: envRoot } }));
    const install = resolvePluginInstall(ctx);
    expect(install).toEqual({ path: envRoot, version: '0.21.0', source: 'env' });
  });

  it('AISDLC-586: falls back to repo-local dev checkout only when nothing else resolves', () => {
    const repoLocalDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(repoLocalDir, { rootVersion: '0.9.2' });
    const ctx = makeCtx(makeAdapters());
    const install = resolvePluginInstall(ctx);
    expect(install?.source).toBe('repo-local');
    expect(install?.path).toBe(repoLocalDir);
  });
});

// ── checkPluginInstallAmbiguity (AISDLC-586) ──────────────────────────

describe('checkPluginInstallAmbiguity', () => {
  it('passes when no repo-local checkout exists', () => {
    const result = checkPluginInstallAmbiguity(makeCtx(makeAdapters()));
    expect(result.severity).toBe('pass');
  });

  it('passes when no marketplace install exists (repo-local only)', () => {
    const repoLocalDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(repoLocalDir, { rootVersion: '0.9.2' });
    const result = checkPluginInstallAmbiguity(makeCtx(makeAdapters()));
    expect(result.severity).toBe('pass');
  });

  it('passes when repo-local and marketplace installs agree on version', () => {
    const homeDir = join(tmpDir, 'home');
    const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
    const marketplaceDir = join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc', '0.18.0');
    writePluginManifests(marketplaceDir, { rootVersion: '0.18.0' });
    const repoLocalDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(repoLocalDir, { rootVersion: '0.18.0' });

    const result = checkPluginInstallAmbiguity(
      makeCtx(
        makeAdapters({
          homeDir: () => homeDir,
          listDir: (p) => {
            if (p === cacheRoot) return ['ai-sdlc-local'];
            if (p === join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc')) return ['0.18.0'];
            return [];
          },
        }),
      ),
    );
    expect(result.severity).toBe('pass');
  });

  it('WARNs naming both paths+versions when repo-local and marketplace disagree', () => {
    const homeDir = join(tmpDir, 'home');
    const cacheRoot = join(homeDir, '.claude', 'plugins', 'cache');
    const marketplaceDir = join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc', '0.18.0');
    writePluginManifests(marketplaceDir, { rootVersion: '0.18.0' });
    const repoLocalDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(repoLocalDir, { rootVersion: '0.9.2' });

    const result = checkPluginInstallAmbiguity(
      makeCtx(
        makeAdapters({
          homeDir: () => homeDir,
          listDir: (p) => {
            if (p === cacheRoot) return ['ai-sdlc-local'];
            if (p === join(cacheRoot, 'ai-sdlc-local', 'ai-sdlc')) return ['0.18.0'];
            return [];
          },
        }),
      ),
    );
    expect(result.severity).toBe('warn');
    expect(result.title).toContain(repoLocalDir);
    expect(result.title).toContain('0.9.2');
    expect(result.title).toContain(marketplaceDir);
    expect(result.title).toContain('0.18.0');
    expect(result.anonymizableEvidence).toEqual({
      repoLocalVersion: '0.9.2',
      marketplaceVersion: '0.18.0',
    });
  });
});

// ── describeResolvedPluginInstall / report header (AISDLC-586) ───────

describe('describeResolvedPluginInstall', () => {
  it('names the audited install path + marketplace version', () => {
    const line = describeResolvedPluginInstall({
      path: '/home/op/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.18.0',
      version: '0.18.0',
      source: 'marketplace',
    });
    expect(line).toBe(
      'Auditing: /home/op/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.18.0 (marketplace v0.18.0)',
    );
  });

  it('names a dev checkout distinctly from a marketplace install', () => {
    const line = describeResolvedPluginInstall({
      path: '/repo/ai-sdlc-plugin',
      version: '0.9.2',
      source: 'repo-local',
    });
    expect(line).toBe('Auditing: /repo/ai-sdlc-plugin (dev checkout v0.9.2)');
  });

  it('reports "no plugin install detected" when nothing resolved', () => {
    expect(describeResolvedPluginInstall(undefined)).toBe('Auditing: no plugin install detected');
  });
});

// ── checkPluginVersion (check 1) ──────────────────────────────────────

describe('checkPluginVersion', () => {
  it('warns when no plugin is installed', () => {
    const result = checkPluginVersion(makeCtx(makeAdapters()));
    expect(result.severity).toBe('warn');
    expect(result.remediation).toContain('/plugin install ai-sdlc');
  });

  it('warns when the plugin is found but hooks/check-plugin-version.js is missing', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: false });
    const result = checkPluginVersion(makeCtx(makeAdapters()));
    expect(result.severity).toBe('warn');
    expect(result.title).toContain('missing');
  });

  it('passes when the hook reports up to date', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: true });
    const result = checkPluginVersion(
      makeCtx(
        makeAdapters({
          runCommand: () => ({
            stdout:
              'ai-sdlc plugin\n- Installed: v1.0.0\n- Latest: v1.0.0\n- Status: ✓ up to date\n',
            exitCode: 0,
          }),
        }),
      ),
    );
    expect(result.severity).toBe('pass');
    expect(result.id).toBe('plugin-version');
  });

  it('warns (not fails) when the hook reports staleness', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: true });
    const result = checkPluginVersion(
      makeCtx(
        makeAdapters({
          runCommand: () => ({
            stdout:
              'ai-sdlc plugin\n- Installed: v1.0.0\n- Latest: v1.1.0\n- Status: ⚠ stale — run /plugin update ai-sdlc && /reload-plugins\n',
            exitCode: 0,
          }),
        }),
      ),
    );
    expect(result.severity).toBe('warn');
    expect(result.remediation).toContain('/plugin update ai-sdlc');
    expect(result.anonymizableEvidence).toEqual({ installed: '1.0.0', latest: '1.1.0' });
  });

  it('warns when the hook output is unparseable/unreachable', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: true });
    const result = checkPluginVersion(
      makeCtx(makeAdapters({ runCommand: () => ({ stdout: '', exitCode: 1 }) })),
    );
    expect(result.severity).toBe('warn');
  });
});

// ── checkRuntimeDepsPins + fix (check 2) ──────────────────────────────

describe('checkRuntimeDepsPins', () => {
  it('warns when no plugin is installed', () => {
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('warn');
  });

  it('flags a caret-0.x pin as a caret trap', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^0.19.0' },
    });
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    const trap = results.find((r) => r.id.startsWith('runtime-deps-caret-trap'));
    expect(trap).toBeTruthy();
    expect(trap!.severity).toBe('warn');
    expect(trap!.title).toContain('^0.19.0');
  });

  it('renders an accurate exact-patch message for a ^0.0.x caret trap', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^0.0.5' },
    });
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    const trap = results.find((r) => r.id.startsWith('runtime-deps-caret-trap'));
    expect(trap).toBeTruthy();
    expect(trap!.severity).toBe('warn');
    expect(trap!.title).toContain('exact patch');
    expect(trap!.title).toContain('^0.0.5');
    // Must NOT claim the (inaccurate) "excludes the next minor" framing.
    expect(trap!.title).not.toContain('next minor');
  });

  it('does NOT flag a >=1.0.0 or ^1.x pin', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.2.0' },
    });
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    expect(results.some((r) => r.id.startsWith('runtime-deps-caret-trap'))).toBe(false);
    expect(results.some((r) => r.severity === 'pass')).toBe(true);
  });

  it('surfaces stale-pin lines from check-stale-runtime-deps.mjs', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^0.20.0' },
      withStaleScript: true,
    });
    const results = checkRuntimeDepsPins(
      makeCtx(
        makeAdapters({
          runCommand: (cmd, args) => {
            if (cmd === 'node' && args[0].includes('check-stale-runtime-deps.mjs')) {
              return { stdout: '@ai-sdlc/orchestrator\t0.20.0\t0.20.1\t^0.20.0\n', exitCode: 0 };
            }
            return { stdout: '', exitCode: 1 };
          },
        }),
      ),
    );
    const stale = results.find((r) => r.id === 'runtime-deps-stale:@ai-sdlc/orchestrator');
    expect(stale).toBeTruthy();
    expect(stale!.severity).toBe('warn');
    expect(stale!.title).toContain('0.20.1');
  });

  it('reports pass with no caret traps and no stale pins', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.0.0' } });
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('pass');
  });

  it('reports fail when plugin.json is invalid JSON', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), 'not json');
    const results = checkRuntimeDepsPins(makeCtx(makeAdapters()));
    expect(results[0].severity).toBe('fail');
  });
});

describe('fixRuntimeDepsPins', () => {
  it('is a no-op (skipped) when no plugin is found', () => {
    const fix = fixRuntimeDepsPins(makeCtx(makeAdapters()));
    expect(fix.applied).toBe(false);
  });

  it('runs install-runtime-deps.sh when present and reports applied', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir);
    mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
    writeFileSync(join(pluginDir, 'scripts', 'install-runtime-deps.sh'), '#!/bin/bash\n');

    const fix = fixRuntimeDepsPins(
      makeCtx(makeAdapters({ runCommand: () => ({ stdout: '', exitCode: 0 }) })),
    );
    expect(fix.applied).toBe(true);
  });

  it('is idempotent — running twice both report the same outcome', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir);
    mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
    writeFileSync(join(pluginDir, 'scripts', 'install-runtime-deps.sh'), '#!/bin/bash\n');

    const ctx = makeCtx(makeAdapters({ runCommand: () => ({ stdout: '', exitCode: 0 }) }));
    const first = fixRuntimeDepsPins(ctx);
    const second = fixRuntimeDepsPins(ctx);
    expect(first).toEqual(second);
  });
});

// ── checkManifestsAgree + fix (check 3) ───────────────────────────────

describe('checkManifestsAgree', () => {
  it('warns when no plugin is installed', () => {
    const result = checkManifestsAgree(makeCtx(makeAdapters()));
    expect(result.severity).toBe('warn');
  });

  it('passes when both manifests agree', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootVersion: '1.2.3' });
    const result = checkManifestsAgree(makeCtx(makeAdapters()));
    expect(result.severity).toBe('pass');
  });

  it('fails when versions disagree', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootVersion: '1.2.3', nestedVersion: '1.2.2' });
    const result = checkManifestsAgree(makeCtx(makeAdapters()));
    expect(result.severity).toBe('fail');
    expect(result.title).toContain('version');
  });

  it('fails when runtimeDependencies disagree', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.0.0' },
      nestedRuntimeDeps: { '@ai-sdlc/orchestrator': '^0.9.0' },
    });
    const result = checkManifestsAgree(makeCtx(makeAdapters()));
    expect(result.severity).toBe('fail');
    expect(result.title).toContain('runtimeDependencies');
  });
});

describe('fixManifestsAgree', () => {
  it('copies root plugin.json over the nested manifest and is idempotent', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootVersion: '2.0.0', nestedVersion: '1.0.0' });
    const ctx = makeCtx(makeAdapters());

    const before = checkManifestsAgree(ctx);
    expect(before.severity).toBe('fail');

    const fix = fixManifestsAgree(ctx);
    expect(fix.applied).toBe(true);

    const after = checkManifestsAgree(ctx);
    expect(after.severity).toBe('pass');

    // Re-running the fix on already-synced manifests is a no-op write.
    const secondFix = fixManifestsAgree(ctx);
    expect(secondFix.applied).toBe(true);
    expect(checkManifestsAgree(ctx).severity).toBe('pass');
  });
});

// ── checkAttestationGovernanceCheck (check 7, reuse of AISDLC-560) ────

describe('checkAttestationGovernanceCheck', () => {
  it('passes when checkAttestationGovernance reports fully-configured', () => {
    const result = checkAttestationGovernanceCheck(
      makeCtx(
        makeAdapters({
          exists: (p) =>
            p.includes('trusted-reviewers.yaml') || p.includes('.ai-sdlc/attestations'),
          runCommand: (cmd, args) => {
            if (args[0] === 'repo') return { stdout: 'acme/widgets', exitCode: 0 };
            if (args[0] === 'api') {
              return {
                stdout: JSON.stringify({
                  required_pull_request_reviews: { required_approving_review_count: 1 },
                  required_status_checks: { contexts: ['ai-sdlc/pr-ready'] },
                }),
                exitCode: 0,
              };
            }
            return { stdout: '', exitCode: 1 };
          },
        }),
      ),
    );
    expect(result.severity).toBe('pass');
  });

  it('warns when neither artifacts nor enforcement are present', () => {
    const result = checkAttestationGovernanceCheck(makeCtx(makeAdapters()));
    expect(result.severity).toBe('warn');
  });

  it('fails when branch protection requires ai-sdlc/attestation directly (AISDLC-388 misconfiguration)', () => {
    const result = checkAttestationGovernanceCheck(
      makeCtx(
        makeAdapters({
          exists: (p) => p.includes('trusted-reviewers.yaml'),
          runCommand: (cmd, args) => {
            if (args[0] === 'repo') return { stdout: 'acme/widgets', exitCode: 0 };
            if (args[0] === 'api') {
              return {
                stdout: JSON.stringify({
                  required_pull_request_reviews: { required_approving_review_count: 1 },
                  required_status_checks: { contexts: ['ai-sdlc/attestation'] },
                }),
                exitCode: 0,
              };
            }
            return { stdout: '', exitCode: 1 };
          },
        }),
      ),
    );
    expect(result.severity).toBe('fail');
    expect(result.title).toContain('ai-sdlc/attestation');
  });
});

// ── checkMarketplaceCatalogDrift (check 11) ───────────────────────────

describe('checkMarketplaceCatalogDrift', () => {
  it('passes with no catalog cache file present', () => {
    const result = checkMarketplaceCatalogDrift(makeCtx(makeAdapters()));
    expect(result.severity).toBe('pass');
  });

  it('warns when the catalog cache cannot be correlated with a resolvable source version', () => {
    const homeDir = join(tmpDir, 'home');
    mkdirSync(join(homeDir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'plugins', 'plugin-catalog-cache.json'),
      JSON.stringify({ plugins: [{ name: 'ai-sdlc', version: '0.16.1' }] }),
    );
    const result = checkMarketplaceCatalogDrift(makeCtx(makeAdapters({ homeDir: () => homeDir })));
    expect(result.severity).toBe('warn');
  });

  it('fails when the catalog cache lags the source-of-truth version', () => {
    const homeDir = join(tmpDir, 'home');
    mkdirSync(join(homeDir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'plugins', 'plugin-catalog-cache.json'),
      JSON.stringify({ plugins: [{ name: 'ai-sdlc', version: '0.16.1' }] }),
    );
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: true });

    const result = checkMarketplaceCatalogDrift(
      makeCtx(
        makeAdapters({
          homeDir: () => homeDir,
          runCommand: () => ({
            stdout: 'ai-sdlc plugin\n- Installed: v0.16.1\n- Latest: v0.17.0\n- Status: ⚠ stale\n',
            exitCode: 0,
          }),
        }),
      ),
    );
    expect(result.severity).toBe('fail');
    expect(result.anonymizableEvidence).toEqual({
      catalogVersion: '0.16.1',
      sourceLatest: '0.17.0',
    });
  });

  it('passes when the catalog cache matches the source-of-truth version', () => {
    const homeDir = join(tmpDir, 'home');
    mkdirSync(join(homeDir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'plugins', 'plugin-catalog-cache.json'),
      JSON.stringify({ plugins: [{ name: 'ai-sdlc', version: '0.17.0' }] }),
    );
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { withHooksScript: true });

    const result = checkMarketplaceCatalogDrift(
      makeCtx(
        makeAdapters({
          homeDir: () => homeDir,
          runCommand: () => ({
            stdout:
              'ai-sdlc plugin\n- Installed: v0.17.0\n- Latest: v0.17.0\n- Status: ✓ up to date\n',
            exitCode: 0,
          }),
        }),
      ),
    );
    expect(result.severity).toBe('pass');
  });
});

// ── checkNpmDistTagReachability (check 12) ────────────────────────────

describe('checkNpmDistTagReachability', () => {
  it('warns when no plugin is installed', () => {
    const results = checkNpmDistTagReachability(makeCtx(makeAdapters()));
    expect(results[0].severity).toBe('warn');
  });

  it('passes when npm view resolves the pin', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.0.0' } });
    const results = checkNpmDistTagReachability(
      makeCtx(makeAdapters({ runCommand: () => ({ stdout: '1.2.0\n', exitCode: 0 }) })),
    );
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('pass');
    expect(results[0].anonymizableEvidence).toMatchObject({ resolved: '1.2.0' });
  });

  it('fails per-pin when the registry replies the version does not exist (E404)', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^99.0.0' } });
    const results = checkNpmDistTagReachability(
      makeCtx(
        makeAdapters({
          runCommand: () => ({
            stdout: '',
            exitCode: 1,
            stderr: 'npm error code E404\nnpm error 404 Not Found',
          }),
        }),
      ),
    );
    expect(results[0].severity).toBe('fail');
    expect(results[0].id).toBe('npm-dist-tag:@ai-sdlc/orchestrator');
  });

  it('fails per-pin when npm exits 0 but resolves no version (empty range match)', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^99.0.0' } });
    const results = checkNpmDistTagReachability(
      makeCtx(makeAdapters({ runCommand: () => ({ stdout: '', exitCode: 0, stderr: '' }) })),
    );
    expect(results[0].severity).toBe('fail');
  });

  it('warns (fail-open), not fails, when the npm registry is unreachable (offline/DNS/timeout)', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^0.20.0' } });
    const results = checkNpmDistTagReachability(
      makeCtx(
        makeAdapters({
          runCommand: () => ({
            stdout: '',
            exitCode: 1,
            stderr:
              'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
          }),
        }),
      ),
    );
    expect(results[0].severity).toBe('warn');
    expect(results[0].id).toBe('npm-dist-tag:@ai-sdlc/orchestrator');
  });

  it('passes "--" to npm view so a name/pin starting with "-" is not parsed as a flag', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, { rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.0.0' } });
    let capturedArgs: string[] = [];
    checkNpmDistTagReachability(
      makeCtx(
        makeAdapters({
          runCommand: (_cmd, args) => {
            capturedArgs = args;
            return { stdout: '1.2.0\n', exitCode: 0, stderr: '' };
          },
        }),
      ),
    );
    expect(capturedArgs).toContain('--');
    expect(capturedArgs.indexOf('--')).toBeLessThan(
      capturedArgs.indexOf('@ai-sdlc/orchestrator@^1.0.0'),
    );
  });

  it('reports pass with no pins to check', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir);
    const results = checkNpmDistTagReachability(makeCtx(makeAdapters()));
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe('pass');
  });
});

// ── Registry + runner + summary + render ──────────────────────────────

describe('DOCTOR_CHECKS registry', () => {
  it('has unique, non-empty ids', () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('covers checks 1, 2, 3, 7, 11, 12 from the AISDLC-578 seed catalog plus the AISDLC-586 ambiguity check', () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'plugin-version',
        'runtime-deps-pins',
        'manifests-agree',
        'plugin-install-ambiguity',
        'attestation-governance',
        'marketplace-catalog-drift',
        'npm-dist-tag-reachability',
      ]),
    );
  });
});

describe('runDoctorChecks + summarizeDoctorResults', () => {
  it('a known-good project (no plugin dir, no attestation artifacts, clean gh) reports zero fails', () => {
    const results = runDoctorChecks(makeCtx(makeAdapters()));
    const summary = summarizeDoctorResults(results);
    expect(summary.fail).toBe(0);
    expect(summary.total).toBe(results.length);
  });

  it('a fully-configured, fully-agreeing project passes every applicable check', () => {
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    writePluginManifests(pluginDir, {
      rootRuntimeDeps: { '@ai-sdlc/orchestrator': '^1.0.0' },
      withHooksScript: true,
    });
    mkdirSync(join(tmpDir, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers: []\n');

    const results = runDoctorChecks(
      makeCtx(
        makeAdapters({
          runCommand: (cmd, args) => {
            if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'acme/widgets', exitCode: 0 };
            if (cmd === 'gh' && args[0] === 'api') {
              return {
                stdout: JSON.stringify({
                  required_pull_request_reviews: { required_approving_review_count: 1 },
                  required_status_checks: { contexts: ['ai-sdlc/pr-ready'] },
                }),
                exitCode: 0,
              };
            }
            if (cmd === 'node' && args[0].includes('check-plugin-version.js')) {
              return {
                stdout:
                  'ai-sdlc plugin\n- Installed: v1.0.0\n- Latest: v1.0.0\n- Status: ✓ up to date\n',
                exitCode: 0,
              };
            }
            if (cmd === 'npm') return { stdout: '1.0.0\n', exitCode: 0 };
            return { stdout: '', exitCode: 1 };
          },
        }),
      ),
    );
    const summary = summarizeDoctorResults(results);
    expect(summary.fail).toBe(0);
  });

  it('runDoctorFixes only invokes checks that declare a fix()', () => {
    const fixes = runDoctorFixes(makeCtx(makeAdapters()));
    const fixableIds = DOCTOR_CHECKS.filter((c) => c.fix).map((c) => c.id);
    expect(fixes.map((f) => f.id).sort()).toEqual(fixableIds.sort());
  });
});

describe('renderFullDoctorReport', () => {
  it('renders every result with its severity glyph and a trailing summary line', () => {
    const results = runDoctorChecks(makeCtx(makeAdapters()));
    const lines = renderFullDoctorReport(results);
    expect(lines[0]).toBe('AI-SDLC Doctor');
    expect(lines.some((l) => /\d+ pass, \d+ warn, \d+ fail \(\d+ checks\)/.test(l))).toBe(true);
    for (const result of results) {
      expect(lines.some((l) => l.includes(result.id))).toBe(true);
    }
  });

  it('names the audited install path + version in the header (AISDLC-586)', () => {
    const results = runDoctorChecks(makeCtx(makeAdapters()));
    const lines = renderFullDoctorReport(results, {
      path: '/home/op/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.18.0',
      version: '0.18.0',
      source: 'marketplace',
    });
    expect(
      lines.some((l) =>
        l.includes(
          'Auditing: /home/op/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.18.0 (marketplace v0.18.0)',
        ),
      ),
    ).toBe(true);
  });

  it('reports "no plugin install detected" in the header when nothing resolved', () => {
    const results = runDoctorChecks(makeCtx(makeAdapters()));
    const lines = renderFullDoctorReport(results);
    expect(lines.some((l) => l === 'Auditing: no plugin install detected')).toBe(true);
  });
});
