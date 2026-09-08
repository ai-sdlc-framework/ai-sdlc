/**
 * Hermetic tests for the `merge-if-eligible` deterministic core
 * (RFC-0048 Phase 3 / AISDLC-603).
 *
 * No real `gh` calls: every test drives a `FakeRunner`. Policy resolution
 * is exercised both via the injectable `loadPolicy` seam (pure-evaluator
 * tests) and via a real temp-directory `.ai-sdlc/agent-role.yaml` +
 * a stub resolver module (integration-flavoured tests for
 * `resolveRepoGovernancePolicy`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateMergeEligibility,
  fetchAllCheckRuns,
  fetchMergeStateStatus,
  fetchRequiredChecks,
  highestVersionCacheGovernanceResolverPath,
  isTrustedSourceKind,
  loadGovernanceResolverModule,
  mergePr,
  resolveInstalledPluginGovernanceResolverPath,
  resolveRepoGovernancePolicy,
  resolveRepoSlug,
  runMergeIfEligible,
  STRICT_DEFAULTS,
  type GovernancePolicy,
} from './merge-if-eligible.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

const ORIGINAL_ENV = { ...process.env };

function resetPluginEnv(): void {
  delete process.env['CLAUDE_PLUGIN_DIR'];
  delete process.env['CLAUDE_PLUGIN_ROOT'];
}

// ── FakeRunner ────────────────────────────────────────────────────────

interface RecordedCall {
  command: string;
  args: string[];
}

function makeFakeRunner(handlers: Record<string, Partial<ExecResult> | Error>) {
  const calls: RecordedCall[] = [];
  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(' ')}`;
    for (const [pattern, response] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        if (response instanceof Error) throw response;
        const r: ExecResult = { stdout: '', stderr: '', code: 0, ...response };
        if (r.code !== 0 && !opts?.allowFailure) {
          throw new Error(`fake ${key} failed`);
        }
        return r;
      }
    }
    throw new Error(`no fake handler registered for: ${key}`);
  };
  return { runner, calls };
}

const GREEN_CLEAN_POLICY: GovernancePolicy = {
  allowMerge: 'onGreenClean',
  allowForcePush: false,
  allowClosePrIssue: false,
  allowBranchDelete: false,
  allowResetHard: false,
};

// ── evaluateMergeEligibility (pure) ──────────────────────────────────

describe('evaluateMergeEligibility', () => {
  it('AC1 — refuses under strict allowMerge: never', () => {
    const result = evaluateMergeEligibility({
      policy: STRICT_DEFAULTS,
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'ci', state: 'SUCCESS' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/allowMerge="never"/);
  });

  it('AC2 — merges when green + CLEAN + trusted under onGreenClean', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [
        { name: 'ci', state: 'SUCCESS' },
        { name: 'verify-attestation', state: 'success' },
      ],
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toMatch(/eligible for agent-initiated merge/);
  });

  it('refuses when a required check is not green', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [
        { name: 'ci', state: 'SUCCESS' },
        { name: 'Backlog Drift', state: 'FAILURE' },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Backlog Drift=FAILURE/);
  });

  it('refuses when a required check is still PENDING/queued (not yet SUCCESS)', () => {
    // A merge-authorization gate must treat an unfinished check as not-green
    // (fail-closed) — a queued check that later fails would otherwise slip a
    // premature merge through. Only an exact SUCCESS is green.
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [
        { name: 'ci', state: 'SUCCESS' },
        { name: 'ai-sdlc/pr-ready', state: 'PENDING' },
      ],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/ai-sdlc\/pr-ready=PENDING/);
  });

  it('refuses when mergeStateStatus is not CLEAN', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'backlog',
      mergeStateStatus: 'BEHIND',
      requiredChecks: [{ name: 'ci', state: 'SUCCESS' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/mergeStateStatus="BEHIND"/);
  });

  it('AC3 — never merges an untrusted (gh-issue) sourceKind, even green+CLEAN', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'gh-issue',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'ci', state: 'SUCCESS' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/sourceKind="gh-issue" is not trusted/);
  });

  it('refuses an unset sourceKind (fail-closed)', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: undefined,
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'ci', state: 'SUCCESS' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/sourceKind="\(unset\)" is not trusted/);
  });

  it('refuses an empty required-checks set even when green+CLEAN+trusted (fail-closed)', () => {
    const result = evaluateMergeEligibility({
      policy: GREEN_CLEAN_POLICY,
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no required checks were resolved/);
  });
});

describe('isTrustedSourceKind', () => {
  it('trusts only "backlog"', () => {
    expect(isTrustedSourceKind('backlog')).toBe(true);
    expect(isTrustedSourceKind('gh-issue')).toBe(false);
    expect(isTrustedSourceKind(undefined)).toBe(false);
  });
});

// ── resolveRepoGovernancePolicy ──────────────────────────────────────

describe('resolveRepoGovernancePolicy', () => {
  let dir: string;

  beforeEach(resetPluginEnv);

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it('fails closed to STRICT_DEFAULTS when the resolver module cannot be located', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-'));
    const policy = resolveRepoGovernancePolicy(dir, join(dir, 'nonexistent-pkg-root'));
    expect(policy).toEqual(STRICT_DEFAULTS);
  });

  it('AC-1 — simulated marketplace/consumer layout: loads the REAL resolver via CLAUDE_PLUGIN_ROOT (not the monorepo sibling) and returns onGreenClean', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-607-e2e-'));
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(dir, '.ai-sdlc', 'agent-role.yaml'),
      'spec:\n  governance:\n    preset: operator-trusted\n',
      'utf-8',
    );

    const pluginRoot = join(dir, 'installed-plugin');
    const hooksLibDir = join(pluginRoot, 'hooks', 'lib');
    mkdirSync(hooksLibDir, { recursive: true });
    const realResolverPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'ai-sdlc-plugin',
      'hooks',
      'lib',
      'governance-resolver.js',
    );
    cpSync(realResolverPath, join(hooksLibDir, 'governance-resolver.js'));
    process.env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;

    // pkgRoot points at a nonexistent monorepo sibling — the ONLY way this
    // resolves is via the installed-plugin (env-var) path.
    const policy = resolveRepoGovernancePolicy(dir, join(dir, 'nonexistent-pipeline-cli-pkg-root'));
    expect(policy.allowMerge).toBe('onGreenClean');
  });

  it('fails closed to STRICT_DEFAULTS when agent-role.yaml is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-'));
    const stubResolver = {
      resolveGovernanceFromYaml: (yamlText: string): GovernancePolicy =>
        yamlText.includes('onGreenClean') ? GREEN_CLEAN_POLICY : { ...STRICT_DEFAULTS },
    };
    const policy = resolveRepoGovernancePolicy(dir, '/unused', stubResolver);
    expect(policy).toEqual(STRICT_DEFAULTS);
  });

  it('reads governance from the given repoRoot (trusted base checkout), not a PR tree', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-'));
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(dir, '.ai-sdlc', 'agent-role.yaml'),
      'spec:\n  governance:\n    allowMerge: onGreenClean\n',
      'utf-8',
    );
    const stubResolver = {
      resolveGovernanceFromYaml: (yamlText: string): GovernancePolicy =>
        yamlText.includes('onGreenClean') ? GREEN_CLEAN_POLICY : { ...STRICT_DEFAULTS },
    };
    const policy = resolveRepoGovernancePolicy(dir, '/unused', stubResolver);
    expect(policy.allowMerge).toBe('onGreenClean');
  });

  it('fails closed when the resolver module throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-'));
    const throwingResolver = {
      resolveGovernanceFromYaml: (): GovernancePolicy => {
        throw new Error('boom');
      },
    };
    const policy = resolveRepoGovernancePolicy(dir, '/unused', throwingResolver);
    expect(policy).toEqual(STRICT_DEFAULTS);
  });
});

describe('loadGovernanceResolverModule', () => {
  beforeEach(resetPluginEnv);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolves the real AISDLC-601 resolver from this monorepo checkout (dogfood fallback)', () => {
    // pipeline-cli/src/governance/merge-if-eligible.test.ts → pkgRoot is
    // pipeline-cli/ itself (two levels up from this file at runtime via
    // import.meta.url in the SUT — here we pass it explicitly).
    const pkgRoot = join(__dirname, '..', '..');
    const mod = loadGovernanceResolverModule(pkgRoot);
    expect(mod).not.toBeNull();
    expect(typeof mod?.resolveGovernanceFromYaml).toBe('function');
  });

  it('AC-2 — returns null when the resolver cannot be found anywhere (fail-closed preserved)', () => {
    const mod = loadGovernanceResolverModule(
      '/tmp/definitely-not-a-real-monorepo-root',
      '/tmp/definitely-not-a-real-cache-root',
    );
    expect(mod).toBeNull();
  });

  it('AC-1 — resolves the resolver from $CLAUDE_PLUGIN_ROOT (installed-plugin layout), NOT the monorepo sibling', () => {
    // Simulate a marketplace/consumer install: the plugin's governance
    // resolver lives under an installed-plugin path, NOT as a
    // pipeline-cli sibling. loadGovernanceResolverModule must find it via
    // the CLAUDE_PLUGIN_ROOT env var, never touching the (nonexistent)
    // monorepo-sibling fallback.
    const base = mkdtempSync(join(tmpdir(), 'aisdlc-607-installed-plugin-'));
    try {
      const hooksLibDir = join(base, 'hooks', 'lib');
      mkdirSync(hooksLibDir, { recursive: true });
      const realResolverPath = join(
        __dirname,
        '..',
        '..',
        '..',
        'ai-sdlc-plugin',
        'hooks',
        'lib',
        'governance-resolver.js',
      );
      cpSync(realResolverPath, join(hooksLibDir, 'governance-resolver.js'));
      process.env['CLAUDE_PLUGIN_ROOT'] = base;

      const mod = loadGovernanceResolverModule('/tmp/definitely-not-a-real-monorepo-root');
      expect(mod).not.toBeNull();
      expect(typeof mod?.resolveGovernanceFromYaml).toBe('function');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('resolveInstalledPluginGovernanceResolverPath + highestVersionCacheGovernanceResolverPath (AISDLC-607 Defect 1)', () => {
  let cacheRoot: string;

  beforeEach(() => {
    resetPluginEnv();
    cacheRoot = mkdtempSync(join(tmpdir(), 'aisdlc-607-cache-'));
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  function seed(marketplace: string, version: string): string {
    const dir = join(cacheRoot, marketplace, 'ai-sdlc', version, 'hooks', 'lib');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'governance-resolver.js');
    writeFileSync(p, 'module.exports = { resolveGovernanceFromYaml: () => ({}) };\n');
    return p;
  }

  it('returns null when the cache root does not exist and no env vars are set', () => {
    expect(resolveInstalledPluginGovernanceResolverPath(join(cacheRoot, 'missing'))).toBeNull();
  });

  it('resolves from $CLAUDE_PLUGIN_ROOT/hooks/lib/governance-resolver.js when present', () => {
    const pluginDir = join(cacheRoot, 'plugin-root');
    const hooksLibDir = join(pluginDir, 'hooks', 'lib');
    mkdirSync(hooksLibDir, { recursive: true });
    const p = join(hooksLibDir, 'governance-resolver.js');
    writeFileSync(p, 'module.exports = {};\n');
    process.env['CLAUDE_PLUGIN_ROOT'] = pluginDir;

    expect(resolveInstalledPluginGovernanceResolverPath()).toBe(p);
  });

  it('prefers $CLAUDE_PLUGIN_ROOT over $CLAUDE_PLUGIN_DIR when both resolve', () => {
    const rootFile = join(cacheRoot, 'root', 'hooks', 'lib', 'governance-resolver.js');
    mkdirSync(join(cacheRoot, 'root', 'hooks', 'lib'), { recursive: true });
    writeFileSync(rootFile, 'module.exports = {};\n');
    process.env['CLAUDE_PLUGIN_ROOT'] = join(cacheRoot, 'root');

    const dirFile = join(cacheRoot, 'dir', 'hooks', 'lib', 'governance-resolver.js');
    mkdirSync(join(cacheRoot, 'dir', 'hooks', 'lib'), { recursive: true });
    writeFileSync(dirFile, 'module.exports = {};\n');
    process.env['CLAUDE_PLUGIN_DIR'] = join(cacheRoot, 'dir');

    expect(resolveInstalledPluginGovernanceResolverPath()).toBe(rootFile);
  });

  it('picks the highest version across multiple versions (numeric, not lexical)', () => {
    seed('acme-marketplace', '0.9.0');
    const newest = seed('acme-marketplace', '0.20.1'); // 0.20.1 > 0.9.0 numerically
    expect(highestVersionCacheGovernanceResolverPath(cacheRoot)).toBe(newest);
    expect(resolveInstalledPluginGovernanceResolverPath(cacheRoot)).toBe(newest);
  });

  it('skips a version dir without hooks/lib/governance-resolver.js', () => {
    mkdirSync(join(cacheRoot, 'mp', 'ai-sdlc', '0.22.0'), { recursive: true }); // no hooks/lib file
    const withFile = seed('mp', '0.20.0');
    expect(highestVersionCacheGovernanceResolverPath(cacheRoot)).toBe(withFile);
  });

  it('never throws when env vars point at nonexistent paths', () => {
    process.env['CLAUDE_PLUGIN_ROOT'] = join(cacheRoot, 'does-not-exist');
    expect(() => resolveInstalledPluginGovernanceResolverPath(cacheRoot)).not.toThrow();
  });
});

// ── GitHub data plumbing ──────────────────────────────────────────────

describe('fetchRequiredChecks', () => {
  it('parses the real required-checks set from `gh pr checks --required`', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'verify-attestation', state: 'SUCCESS' },
          { name: 'migration-mutation-gate', state: 'PENDING' },
        ]),
      },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({
      fetchFailed: false,
      checks: [
        { name: 'ci', state: 'SUCCESS' },
        { name: 'verify-attestation', state: 'SUCCESS' },
        { name: 'migration-mutation-gate', state: 'PENDING' },
      ],
    });
  });

  it('AC-3/AC-5 — a repo with no required contexts returns an empty-but-SUCCESSFUL result, not a failure', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': { stdout: '[]' },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: false, checks: [] });
  });

  it('AC-5 — fetchFailed=true on gh failure (fail-closed downstream, never conflated with "no required contexts")', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': { code: 1, stderr: 'not found' },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: true, checks: [] });
  });

  it('AC-5 — fetchFailed=true on unparseable JSON', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': { stdout: 'not json' },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: true, checks: [] });
  });
});

describe('fetchAllCheckRuns (AISDLC-607 Defect 2 fallback)', () => {
  it('parses the PR real check-runs from `gh pr checks` (unfiltered, no --required)', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr checks 42 --json': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'lint', state: 'NEUTRAL' },
        ]),
      },
    });
    const result = await fetchAllCheckRuns(42, 'org/repo', runner);
    expect(result).toEqual({
      fetchFailed: false,
      checks: [
        { name: 'ci', state: 'SUCCESS' },
        { name: 'lint', state: 'NEUTRAL' },
      ],
    });
    // Never passes --required — this is the unfiltered fallback fetch.
    expect(calls[0]?.args).not.toContain('--required');
  });

  it('fetchFailed=true on gh failure', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --json': { code: 1, stderr: 'boom' },
    });
    const result = await fetchAllCheckRuns(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: true, checks: [] });
  });

  it('fetchFailed=true on unparseable JSON', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --json': { stdout: 'not json' },
    });
    const result = await fetchAllCheckRuns(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: true, checks: [] });
  });
});

describe('fetchMergeStateStatus', () => {
  it('parses mergeStateStatus from `gh pr view`', async () => {
    const { runner } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
    });
    expect(await fetchMergeStateStatus(42, 'org/repo', runner)).toBe('CLEAN');
  });

  it('returns UNKNOWN on gh failure', async () => {
    const { runner } = makeFakeRunner({
      'gh pr view 42': { code: 1, stderr: 'boom' },
    });
    expect(await fetchMergeStateStatus(42, 'org/repo', runner)).toBe('UNKNOWN');
  });
});

describe('resolveRepoSlug', () => {
  it('parses the repo slug', async () => {
    const { runner } = makeFakeRunner({
      'gh repo view': { stdout: 'org/repo\n' },
    });
    expect(await resolveRepoSlug(runner)).toBe('org/repo');
  });
});

describe('mergePr', () => {
  it('invokes gh pr merge with the configured method', async () => {
    const { runner, calls } = makeFakeRunner({ 'gh pr merge': {} });
    await mergePr(42, 'org/repo', 'squash', runner);
    expect(calls).toEqual([
      { command: 'gh', args: ['pr', 'merge', '42', '--squash', '--repo', 'org/repo'] },
    ]);
  });
});

// ── runMergeIfEligible (composition) ─────────────────────────────────

describe('runMergeIfEligible', () => {
  it('AC1 — never calls gh at all under strict policy, refuses non-zero-equivalent', async () => {
    const { runner, calls } = makeFakeRunner({});
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => STRICT_DEFAULTS,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls).toEqual([]); // no gh calls at all — short-circuited
  });

  it('AC3 — never calls gh at all for an untrusted sourceKind under onGreenClean', async () => {
    const { runner, calls } = makeFakeRunner({});
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'gh-issue',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it('AC2 — merges when green + CLEAN + trusted', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]),
      },
      'gh pr merge 42': {},
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.merged).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(true);
  });

  it('refuses (no merge call) when a required check is not green', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([{ name: 'ci', state: 'FAILURE' }]),
      },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('refuses (no merge call) when mergeStateStatus is not CLEAN', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'DIRTY' }) },
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]),
      },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('dry-run never calls gh pr merge even when eligible', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]),
      },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
      dryRun: true,
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('uses the real filesystem-backed resolveRepoGovernancePolicy when loadPolicy is omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-run-'));
    try {
      // No .ai-sdlc/agent-role.yaml and no ai-sdlc-plugin sibling at this
      // synthetic pkgRoot → fails closed to STRICT_DEFAULTS → refused,
      // zero gh calls.
      const { runner, calls } = makeFakeRunner({});
      const result = await runMergeIfEligible({
        prNumber: 42,
        sourceKind: 'backlog',
        repoSlug: 'org/repo',
        repoRoot: dir,
        pkgRoot: join(dir, 'pipeline-cli'),
        runner,
      });
      expect(result.eligibility.eligible).toBe(false);
      expect(result.policy).toEqual(STRICT_DEFAULTS);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── AISDLC-607 Defect 2: check-run fallback when no required contexts ──

  it('AC-3 — no required contexts, all real check-runs SUCCESS/NEUTRAL/none-pending → ELIGIBLE', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': { stdout: '[]' }, // branch protection: no required contexts
      'gh pr checks 42 --json': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'lint', state: 'NEUTRAL' },
          { name: 'legacy-skipped-job', state: 'SKIPPED' },
        ]),
      },
      'gh pr merge 42': {},
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason).toMatch(/check-run fallback/);
    expect(result.merged).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(true);
  });

  it('AC-4 — no required contexts, a check-run FAILURE → REFUSES with an auditable reason', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': { stdout: '[]' },
      'gh pr checks 42 --json': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'security-scan', state: 'FAILURE' },
        ]),
      },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/security-scan=FAILURE/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-4 — no required contexts, a check-run PENDING → REFUSES with an auditable reason', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': { stdout: '[]' },
      'gh pr checks 42 --json': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'slow-integration-test', state: 'PENDING' },
        ]),
      },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/slow-integration-test=PENDING/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-5 — the check-run fetch itself errors → REFUSES (fail-closed), NOT treated as vacuously green', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': { stdout: '[]' },
      'gh pr checks 42 --json': { code: 1, stderr: 'gh: unexpected error' },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-5 — the REQUIRED-checks fetch itself errors (not merely empty) → REFUSES without falling back to check-runs', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': { code: 1, stderr: '403 branch protection unavailable' },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    // MUST NOT have fallen through to the unfiltered check-runs fetch —
    // an errored required-checks fetch is never conflated with "no branch
    // protection configured".
    expect(calls.some((c) => c.args.includes('checks') && !c.args.includes('--required'))).toBe(
      false,
    );
    expect(result.merged).toBe(false);
  });

  it('AC-6 — required contexts present: behavior is byte-identical to the pre-AISDLC-607 path (no fallback fetch at all)', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
      'gh pr checks 42 --required': {
        stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]),
      },
      'gh pr merge 42': {},
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason).toMatch(/all 1 required check\(s\) green/);
    expect(result.eligibility.reason).not.toMatch(/check-run fallback/);
    expect(result.merged).toBe(true);
    // The unfiltered `gh pr checks 42 --json ...` (no --required) fallback
    // fetch must NOT have been invoked — required contexts were found.
    expect(calls.some((c) => c.args.includes('checks') && !c.args.includes('--required'))).toBe(
      false,
    );
  });
});
