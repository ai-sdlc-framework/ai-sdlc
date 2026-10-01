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
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveTaskId,
  evaluateMergeEligibility,
  evaluatePrTrust,
  fetchAllCheckRuns,
  fetchPrSnapshot,
  fetchRequiredChecks,
  highestVersionCacheGovernanceResolverPath,
  isBacklogTaskFileFor,
  isTrustedSourceKind,
  loadGovernanceResolverModule,
  loadTrustedPolicyModule,
  mergePr,
  resolveRepoMergeAuthors,
  resolveTrustedMainRoot,
  TEST_ONLY_POLICY_ROOT_ENV,
  resolveInstalledPluginGovernanceResolverPath,
  resolveRepoGovernancePolicy,
  resolveRepoSlug,
  runMergeIfEligible,
  STRICT_DEFAULTS,
  type GovernancePolicy,
  type PrSnapshot,
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

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

/** A trusted, mergeable PR-view response; override single fields. */
function prView(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headRefOid: HEAD_A,
    headRefName: 'ai-sdlc/aisdlc-9-do-thing',
    baseRefName: 'main',
    isCrossRepository: false,
    author: { login: 'operator' },
    title: 'fix(spec): do the thing (AISDLC-9)',
    mergeStateStatus: 'CLEAN',
    files: [{ path: 'backlog/completed/aisdlc-9 - do the thing.md', changeType: 'ADDED' }],
    ...overrides,
  });
}

const SNAPSHOT: PrSnapshot = {
  headRefOid: HEAD_A,
  headRefName: 'ai-sdlc/aisdlc-9-do-thing',
  baseRefName: 'main',
  isCrossRepository: false,
  authorLogin: 'operator',
  title: 'fix(spec): do the thing (AISDLC-9)',
  mergeStateStatus: 'CLEAN',
  files: [],
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

  it('AISDLC-620 AC-1/AC-2 — the "no required checks reported" sentinel on exit-1 is treated as a SUCCESSFUL empty fetch, not a failure', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': {
        code: 1,
        stderr: "no required checks reported on the 'main' branch",
      },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: false, checks: [] });
  });

  it('AISDLC-620 AC-1/AC-2 — the sentinel match is case-insensitive and stderr-only (never matched against stdout content)', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': {
        code: 1,
        stderr: "NO REQUIRED CHECKS REPORTED on the 'release/1.x' branch",
      },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: false, checks: [] });
  });

  it('AISDLC-620 AC-2 — a GENUINE exit-1 error that does NOT match the sentinel still fails closed', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': {
        code: 1,
        stderr: 'gh: authentication required. run `gh auth login`',
      },
    });
    const result = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(result).toEqual({ fetchFailed: true, checks: [] });
  });

  it('AISDLC-620 AC-2 — a genuine network-failure exit-1 still fails closed', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': {
        code: 1,
        stderr: 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
      },
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

describe('resolveRepoSlug', () => {
  it('parses the repo slug', async () => {
    const { runner } = makeFakeRunner({
      'gh repo view': { stdout: 'org/repo\n' },
    });
    expect(await resolveRepoSlug(runner)).toBe('org/repo');
  });
});

describe('mergePr', () => {
  it('invokes the merge with the configured method, pinned to the checked head commit', async () => {
    const { runner, calls } = makeFakeRunner({ 'gh pr merge': {} });
    const res = await mergePr(42, 'org/repo', 'squash', HEAD_A, runner);
    expect(res).toEqual({ ok: true, error: '' });
    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'pr',
          'merge',
          '42',
          '--squash',
          '--match-head-commit',
          HEAD_A,
          '--repo',
          'org/repo',
        ],
      },
    ]);
  });

  it('reports (does not throw) a refusal such as a moved head', async () => {
    const { runner } = makeFakeRunner({
      'gh pr merge': {
        code: 1,
        stderr: 'Head branch was modified. Review and try the merge again.\n',
      },
    });
    const res = await mergePr(42, 'org/repo', 'squash', HEAD_A, runner);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Head branch was modified/);
  });
});

describe('fetchPrSnapshot', () => {
  it('reads head, merge state, provenance and files in ONE gh pr view call', async () => {
    const { runner, calls } = makeFakeRunner({ 'gh pr view 42': { stdout: prView() } });
    const snap = await fetchPrSnapshot(42, 'org/repo', runner);
    expect(snap).toMatchObject({
      headRefOid: HEAD_A,
      baseRefName: 'main',
      isCrossRepository: false,
      authorLogin: 'operator',
      mergeStateStatus: 'CLEAN',
    });
    expect(snap?.files).toEqual([
      { path: 'backlog/completed/aisdlc-9 - do the thing.md', changeType: 'ADDED' },
    ]);
    expect(calls).toHaveLength(1);
    const fields = calls[0].args[calls[0].args.indexOf('--json') + 1];
    for (const f of ['headRefOid', 'mergeStateStatus', 'isCrossRepository', 'author', 'files']) {
      expect(fields).toContain(f);
    }
  });

  it('returns null on gh failure, unparseable output, or any malformed/missing field', async () => {
    const failing = makeFakeRunner({ 'gh pr view 42': { code: 1, stderr: 'boom' } });
    expect(await fetchPrSnapshot(42, 'org/repo', failing.runner)).toBeNull();
    const garbage = makeFakeRunner({ 'gh pr view 42': { stdout: 'not json' } });
    expect(await fetchPrSnapshot(42, 'org/repo', garbage.runner)).toBeNull();
    for (const bad of [
      { headRefOid: 'abc' },
      { headRefOid: undefined },
      { isCrossRepository: undefined },
      { isCrossRepository: 'false' },
      { author: null },
      { author: {} },
      { baseRefName: undefined },
      { headRefName: undefined },
      { title: undefined },
      { mergeStateStatus: undefined },
    ]) {
      const r = makeFakeRunner({ 'gh pr view 42': { stdout: prView(bad) } });
      expect(await fetchPrSnapshot(42, 'org/repo', r.runner)).toBeNull();
    }
  });

  it('tolerates a missing files array (treated as no files)', async () => {
    const r = makeFakeRunner({ 'gh pr view 42': { stdout: prView({ files: undefined }) } });
    expect((await fetchPrSnapshot(42, 'org/repo', r.runner))?.files).toEqual([]);
  });
});

describe('deriveTaskId + isBacklogTaskFileFor', () => {
  it('derives the id from the ai-sdlc/<id>-... branch, including dotted sub-ids', () => {
    expect(deriveTaskId('ai-sdlc/aisdlc-663.5-harden-it', 'whatever').taskId).toBe('aisdlc-663.5');
    expect(deriveTaskId('ai-sdlc/AISDLC-9', 'x').taskId).toBe('aisdlc-9');
  });

  it('falls back to a trailing (ID) in the title when the branch has no id', () => {
    expect(deriveTaskId('feature/foo', 'fix(spec): x (AISDLC-12)').taskId).toBe('aisdlc-12');
  });

  it('refuses disagreeing branch/title ids and returns null when neither names a task', () => {
    const c = deriveTaskId('ai-sdlc/aisdlc-1-a', 'fix: a (AISDLC-2)');
    expect(c.taskId).toBeNull();
    expect(c.conflict).toMatch(/aisdlc-1/i);
    expect(deriveTaskId('ai-sdlc/issue-12', 'fix: a').taskId).toBe('issue-12');
    expect(deriveTaskId('feature/foo', 'fix: a').taskId).toBeNull();
  });

  it('matches only backlog/{tasks,completed}/<id> - <slug>.md (id is not a prefix of another id)', () => {
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-9 - x.md')).toBe(true);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/completed/AISDLC-9 - x.md')).toBe(true);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-90 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-9.1 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/other/aisdlc-9 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'docs/backlog/tasks/aisdlc-9 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9.1', 'backlog/tasks/aisdlc-9x1 - x.md')).toBe(false);
  });
});

describe('evaluatePrTrust (GitHub-derived trust facts)', () => {
  const onMain =
    'backlog/completed/aisdlc-9 - do the thing.md\nbacklog/tasks/aisdlc-10 - other.md\n';

  async function trust(
    overrides: Partial<PrSnapshot>,
    opts: { authors?: string[]; lsTree?: string; lsTreeCode?: number } = {},
  ) {
    const { runner, calls } = makeFakeRunner({
      'git ls-tree': { stdout: opts.lsTree ?? onMain, code: opts.lsTreeCode ?? 0 },
    });
    const reason = await evaluatePrTrust({
      snapshot: { ...SNAPSHOT, ...overrides },
      mergeAuthors: opts.authors ?? ['operator'],
      repoRoot: '/main-checkout',
      runner,
    });
    return { reason, calls };
  }

  it('passes for a same-repo, main-based, allow-listed PR whose task is on origin/main', async () => {
    const { reason, calls } = await trust({});
    expect(reason).toBeNull();
    expect(calls[0].args).toEqual([
      'ls-tree',
      '-r',
      '--name-only',
      'origin/main',
      '--',
      'backlog/tasks',
      'backlog/completed',
    ]);
  });

  it('refuses a fork PR (isCrossRepository !== false)', async () => {
    expect((await trust({ isCrossRepository: true })).reason).toMatch(/fork/);
  });

  it('refuses an author who is not on the allow-list, and compares logins case-insensitively', async () => {
    expect((await trust({ authorLogin: 'mallory' })).reason).toMatch(/not on the .*mergeAuthors/);
    expect((await trust({ authorLogin: 'OPERATOR' })).reason).toBeNull();
  });

  it('refuses when the allow-list is empty (fail closed), without any git call', async () => {
    const { reason, calls } = await trust({}, { authors: [] });
    expect(reason).toMatch(/allow-list is configured|empty list trusts nobody/);
    expect(calls).toEqual([]);
  });

  it('refuses a non-main base branch', async () => {
    expect((await trust({ baseRefName: 'release/1.x' })).reason).toMatch(/base branch/);
  });

  it('refuses when no backlog task exists on origin/main or in the PR diff', async () => {
    const { reason } = await trust({
      headRefName: 'ai-sdlc/aisdlc-77-nope',
      title: 'x (AISDLC-77)',
    });
    expect(reason).toMatch(/no backlog task file for "aisdlc-77"/);
  });

  it('refuses when git ls-tree fails (cannot prove the task exists)', async () => {
    const { reason } = await trust({}, { lsTreeCode: 128 });
    expect(reason).toMatch(/no backlog task file/);
  });

  it('refuses when the branch/title carry no task id, or disagree', async () => {
    expect((await trust({ headRefName: 'feature/x', title: 'no id' })).reason).toMatch(
      /no backlog task id/,
    );
    expect((await trust({ title: 'x (AISDLC-10)' })).reason).toMatch(/ambiguous task id/);
  });

  it('accepts a task file added by the PR own diff (created-and-completed in one PR) without a git call', async () => {
    const { reason, calls } = await trust(
      {
        headRefName: 'ai-sdlc/aisdlc-77-new',
        title: 'x (AISDLC-77)',
        files: [{ path: 'backlog/completed/aisdlc-77 - new.md', changeType: 'ADDED' }],
      },
      { lsTree: '' },
    );
    expect(reason).toBeNull();
    expect(calls).toEqual([]);
  });

  it('does not count a task file the PR deletes, nor an unrelated PR file', async () => {
    const base = { headRefName: 'ai-sdlc/aisdlc-77-new', title: 'x (AISDLC-77)' };
    expect(
      (
        await trust(
          { ...base, files: [{ path: 'backlog/tasks/aisdlc-77 - new.md', changeType: 'DELETED' }] },
          { lsTree: '' },
        )
      ).reason,
    ).toMatch(/no backlog task file/);
    expect(
      (
        await trust(
          { ...base, files: [{ path: 'src/aisdlc-77 - new.md', changeType: 'ADDED' }] },
          { lsTree: '' },
        )
      ).reason,
    ).toMatch(/no backlog task file/);
  });
});

describe('resolveRepoMergeAuthors', () => {
  const pkgRoot = join(__dirname, '..', '..');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-663-5-authors-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePolicy(yaml: string): void {
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), yaml);
  }

  it('reads the allow-list with the real resolver', () => {
    writePolicy(
      'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [octocat]\n',
    );
    const mod = loadGovernanceResolverModule(pkgRoot, join(dir, 'no-cache'));
    expect(resolveRepoMergeAuthors(dir, pkgRoot, mod)).toEqual(['octocat']);
  });

  it('without an injected module, falls through an old installed plugin to one that supports the allow-list', () => {
    writePolicy('spec:\n  governance:\n    mergeAuthors: [octocat]\n');
    // The default lookup (installed plugin, then monorepo sibling) must still
    // find a resolver that supports mergeAuthors in this checkout.
    expect(resolveRepoMergeAuthors(dir, pkgRoot)).toEqual(['octocat']);
    expect(resolveRepoMergeAuthors(dir, join(dir, 'nowhere', 'pipeline-cli'))).toEqual(
      expect.any(Array),
    );
  });

  it('loadTrustedPolicyModule skips an old installed plugin lacking trusted-policy.js, and is null when nothing loads', () => {
    const cache = join(dir, 'cache');
    const oldLib = join(cache, 'mkt', 'ai-sdlc', '0.1.0', 'hooks', 'lib');
    mkdirSync(oldLib, { recursive: true });
    writeFileSync(
      join(oldLib, 'governance-resolver.js'),
      'module.exports = { resolveGovernanceFromYaml() { return {}; } };\n',
    );
    delete process.env['CLAUDE_PLUGIN_ROOT'];
    delete process.env['CLAUDE_PLUGIN_DIR'];
    expect(typeof loadTrustedPolicyModule(pkgRoot, cache)?.verifiedMainRoot).toBe('function');
    expect(loadTrustedPolicyModule(join(dir, 'nowhere', 'pipeline-cli'), cache)).toBeNull();
    // A trusted-policy.js without the expected export is not accepted either.
    writeFileSync(join(oldLib, 'trusted-policy.js'), 'module.exports = {};\n');
    expect(loadTrustedPolicyModule(join(dir, 'nowhere', 'pipeline-cli'), cache)).toBeNull();
    writeFileSync(join(oldLib, 'trusted-policy.js'), 'throw new Error("bad");\n');
    expect(loadTrustedPolicyModule(join(dir, 'nowhere', 'pipeline-cli'), cache)).toBeNull();
  });

  it('is empty when the key is absent, the file is missing, the module is missing or too old', () => {
    const mod = loadGovernanceResolverModule(pkgRoot, join(dir, 'no-cache'));
    expect(resolveRepoMergeAuthors(dir, pkgRoot, mod)).toEqual([]); // no file
    writePolicy('spec:\n  governance:\n    allowMerge: onGreenClean\n');
    expect(resolveRepoMergeAuthors(dir, pkgRoot, mod)).toEqual([]); // no key
    writePolicy('spec:\n  governance:\n    mergeAuthors: [octocat]\n');
    expect(resolveRepoMergeAuthors(dir, pkgRoot, null)).toEqual([]);
    expect(
      resolveRepoMergeAuthors(dir, pkgRoot, {
        resolveGovernanceFromYaml: () => STRICT_DEFAULTS,
      }),
    ).toEqual([]);
    expect(
      resolveRepoMergeAuthors(dir, pkgRoot, {
        resolveGovernanceFromYaml: () => STRICT_DEFAULTS,
        resolveMergeAuthorsFromYaml: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual([]);
  });
});

// ── Verified main checkout (H3) ──────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function initRepo(root: string, policy: string): void {
  mkdirSync(root, { recursive: true });
  git(['init', '-q', '-b', 'main'], root);
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), policy);
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);
}

const NEVER_POLICY = 'spec:\n  governance:\n    allowMerge: never\n';
const GREEN_POLICY =
  'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [operator]\n';

describe('resolveTrustedMainRoot + worktree policy copy (H3)', () => {
  const realPkgRoot = join(__dirname, '..', '..');
  let base: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    delete process.env[TEST_ONLY_POLICY_ROOT_ENV];
    base = mkdtempSync(join(tmpdir(), 'aisdlc-663-5-root-'));
    main = join(base, 'main');
    initRepo(main, NEVER_POLICY);
    worktree = join(main, '.worktrees', 'aisdlc-9');
    git(['worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-9-x', worktree], main);
    // The governed worktree rewrites ITS copy of the policy to grant itself merge.
    writeFileSync(join(worktree, '.ai-sdlc', 'agent-role.yaml'), GREEN_POLICY);
    mkdirSync(join(worktree, 'pipeline-cli'), { recursive: true });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(base, { recursive: true, force: true });
  });

  const trustedModule = () => loadTrustedPolicyModule(realPkgRoot, join(base, 'no-cache'));

  it('loads the real trusted-policy helper from the plugin hooks/lib', () => {
    expect(typeof trustedModule()?.verifiedMainRoot).toBe('function');
  });

  it('resolves the MAIN checkout from a worktree CLI + worktree cwd', () => {
    const res = resolveTrustedMainRoot({
      cwd: worktree,
      anchorDir: join(worktree, 'pipeline-cli'),
      trustedModule: trustedModule(),
    });
    expect(res.root && realpathSync(res.root)).toBe(realpathSync(main));
    expect(res.testOverride).toBe(false);
  });

  it('a worktree copy saying onGreenClean is IGNORED when the verified main policy says never', async () => {
    const res = resolveTrustedMainRoot({
      cwd: worktree,
      anchorDir: join(worktree, 'pipeline-cli'),
      trustedModule: trustedModule(),
    });
    const mod = loadGovernanceResolverModule(realPkgRoot, join(base, 'no-cache'));
    // Sanity: the worktree copy WOULD have granted merge.
    expect(resolveRepoGovernancePolicy(worktree, realPkgRoot, mod).allowMerge).toBe('onGreenClean');
    // The trusted root yields `never` and the gate refuses without any gh call.
    expect(resolveRepoGovernancePolicy(res.root!, realPkgRoot, mod).allowMerge).toBe('never');
    const { runner, calls } = makeFakeRunner({});
    const result = await runMergeIfEligible({
      prNumber: 9,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: res.root,
      pkgRoot: realPkgRoot,
      runner,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/allowMerge="never"/);
    expect(calls).toEqual([]);
  });

  it('refuses when cwd belongs to a DIFFERENT repo than the CLI (attacker-controlled repo)', () => {
    const evil = join(base, 'evil');
    initRepo(evil, GREEN_POLICY);
    const res = resolveTrustedMainRoot({
      cwd: evil,
      anchorDir: join(worktree, 'pipeline-cli'),
      trustedModule: trustedModule(),
    });
    expect(res.root).toBeNull();
    expect(res.reason).toMatch(/same verified main checkout/);
  });

  it('refuses when the CLI itself is not inside a verifiable git checkout, or cwd is not a repo', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(
      resolveTrustedMainRoot({ cwd: main, anchorDir: plain, trustedModule: trustedModule() }).root,
    ).toBeNull();
    expect(
      resolveTrustedMainRoot({ cwd: plain, anchorDir: main, trustedModule: trustedModule() }).root,
    ).toBeNull();
  });

  it('refuses when the trusted-policy helper cannot be loaded or throws', () => {
    expect(
      resolveTrustedMainRoot({ cwd: main, anchorDir: main, trustedModule: null }).reason,
    ).toMatch(/could not be loaded/);
    const res = resolveTrustedMainRoot({
      cwd: main,
      anchorDir: main,
      trustedModule: {
        verifiedMainRoot: () => {
          throw new Error('x');
        },
      },
    });
    expect(res.root).toBeNull();
    expect(res.reason).toMatch(/verifying the main checkout failed/);
  });

  it('honours --repo-root ONLY with the explicit test-only env var', () => {
    const args = {
      cwd: worktree,
      anchorDir: join(worktree, 'pipeline-cli'),
      repoRootOverride: worktree,
      trustedModule: trustedModule(),
    };
    // Without the env var the override is ignored (main root wins).
    const prod = resolveTrustedMainRoot(args);
    expect(prod.testOverride).toBe(false);
    expect(prod.root && realpathSync(prod.root)).toBe(realpathSync(main));
    // Any value other than exactly "1" is still production.
    expect(
      resolveTrustedMainRoot({ ...args, env: { [TEST_ONLY_POLICY_ROOT_ENV]: 'true' } })
        .testOverride,
    ).toBe(false);
    // With it, the override is honoured and flagged.
    const t = resolveTrustedMainRoot({ ...args, env: { [TEST_ONLY_POLICY_ROOT_ENV]: '1' } });
    expect(t).toEqual({ root: worktree, reason: '', testOverride: true });
  });

  it('without a verified root the gate refuses and spends no gh call', async () => {
    const { runner, calls } = makeFakeRunner({});
    const result = await runMergeIfEligible({
      prNumber: 9,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: null,
      rootRefusal: 'because',
      pkgRoot: realPkgRoot,
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/verified main checkout.*because/);
    expect(result.policy).toEqual(STRICT_DEFAULTS);
    expect(calls).toEqual([]);
  });
});

describe('runMergeIfEligible — hardened trust + head pin (H1/H2)', () => {
  function run(
    handlers: Record<string, Partial<ExecResult> | Error>,
    extra: Partial<Parameters<typeof runMergeIfEligible>[0]> = {},
  ) {
    const fake = makeFakeRunner(handlers);
    const promise = runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner: fake.runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
      loadMergeAuthors: () => ['operator'],
      ...extra,
    });
    return { promise, calls: fake.calls };
  }
  const CHECKS = {
    'gh pr checks 42 --required': { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]) },
  };
  const mergeCalls = (calls: Array<{ args: string[] }>) =>
    calls.filter((c) => c.args.includes('merge'));

  it('refuses a fork PR before spending a checks call or a merge', async () => {
    const { promise, calls } = run({
      'gh pr view 42': { stdout: prView({ isCrossRepository: true }) },
    });
    const r = await promise;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/fork/);
    expect(calls.every((c) => c.args[1] === 'view')).toBe(true);
  });

  it('refuses the wrong author', async () => {
    const { promise, calls } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView({ author: { login: 'mallory' } }) },
    });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/"mallory" is not on the/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('refuses when the allow-list is empty', async () => {
    const { promise, calls } = run(
      { ...CHECKS, 'gh pr view 42': { stdout: prView() } },
      { loadMergeAuthors: () => [] },
    );
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/mergeAuthors/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('refuses a non-main base', async () => {
    const { promise } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView({ baseRefName: 'dev' }) },
    });
    expect((await promise).eligibility.reason).toMatch(/base branch is "dev"/);
  });

  it('refuses when no matching backlog task exists (PR diff has none, origin/main has none)', async () => {
    const { promise, calls } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView({ files: [] }) },
      'git ls-tree': { stdout: 'backlog/tasks/aisdlc-1 - other.md\n' },
    });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/no backlog task file for "aisdlc-9"/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('merges when the task exists on origin/main (not in the PR diff)', async () => {
    const { promise } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView({ files: [] }) },
      'git ls-tree': { stdout: 'backlog/completed/aisdlc-9 - do the thing.md\n' },
      'gh pr merge 42': {},
    });
    expect((await promise).merged).toBe(true);
  });

  it('refuses when the PR cannot be read in one call', async () => {
    const { promise } = run({ 'gh pr view 42': { code: 1, stderr: 'nope' } });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/could not read the PR/);
    expect(r.merged).toBe(false);
  });

  it('pins the merge to the head commit the checks were evaluated against', async () => {
    const { promise, calls } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView() },
      'gh pr merge 42': {},
    });
    const r = await promise;
    expect(r.merged).toBe(true);
    const merge = mergeCalls(calls)[0];
    expect(merge.args).toEqual(expect.arrayContaining(['--match-head-commit', HEAD_A, '--squash']));
    // Head read, checks, head re-read, merge — in that order.
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'pr view',
      'pr checks',
      'pr view',
      'pr merge',
    ]);
  });

  it('head moved between check and merge: refuses, never calls the merge', async () => {
    let views = 0;
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: Runner = async (command, args) => {
      calls.push({ command, args });
      if (args[1] === 'view') {
        views += 1;
        return {
          stdout: prView({ headRefOid: views === 1 ? HEAD_A : HEAD_B }),
          stderr: '',
          code: 0,
        };
      }
      if (args[1] === 'checks') {
        return { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]), stderr: '', code: 0 };
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const r = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      runner,
      loadPolicy: () => GREEN_CLEAN_POLICY,
      loadMergeAuthors: () => ['operator'],
    });
    expect(r.merged).toBe(false);
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/head moved from a{40} to b{40}/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('head moved after the re-read (GitHub refuses the pinned merge): fails closed with a clear reason', async () => {
    const { promise } = run({
      ...CHECKS,
      'gh pr view 42': { stdout: prView() },
      'gh pr merge 42': { code: 1, stderr: 'Head branch was modified. Review and try again.' },
    });
    const r = await promise;
    expect(r.merged).toBe(false);
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/refused by GitHub.*Head branch was modified/);
  });

  it('refuses when the pre-merge re-read fails or the PR is no longer CLEAN', async () => {
    let views = 0;
    const mk =
      (second: () => { stdout: string; code: number }): Runner =>
      async (_c, args) => {
        if (args[1] === 'view') {
          views += 1;
          return views === 1
            ? { stdout: prView(), stderr: '', code: 0 }
            : { ...second(), stderr: '' };
        }
        return { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]), stderr: '', code: 0 };
      };
    const base = {
      prNumber: 42,
      sourceKind: 'backlog' as const,
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      pkgRoot: '/unused',
      loadPolicy: () => GREEN_CLEAN_POLICY,
      loadMergeAuthors: () => ['operator'],
    };
    views = 0;
    const failed = await runMergeIfEligible({
      ...base,
      runner: mk(() => ({ stdout: '', code: 1 })),
    });
    expect(failed.eligibility.reason).toMatch(/could not re-read the PR/);
    views = 0;
    const dirty = await runMergeIfEligible({
      ...base,
      runner: mk(() => ({ stdout: prView({ mergeStateStatus: 'BEHIND' }), code: 0 })),
    });
    expect(dirty.eligibility.reason).toMatch(/BEHIND.*pre-merge re-read/);
    expect(dirty.merged).toBe(false);
  });

  it('dry-run evaluates the trust facts but never re-reads or merges', async () => {
    const { promise, calls } = run(
      { ...CHECKS, 'gh pr view 42': { stdout: prView() } },
      { dryRun: true },
    );
    const r = await promise;
    expect(r.eligibility.eligible).toBe(true);
    expect(r.merged).toBe(false);
    expect(calls.filter((c) => c.args[1] === 'view')).toHaveLength(1);
    expect(mergeCalls(calls)).toEqual([]);
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it('AC2 — merges when green + CLEAN + trusted', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.merged).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(true);
  });

  it('refuses (no merge call) when a required check is not green', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('refuses (no merge call) when mergeStateStatus is not CLEAN', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView({ mergeStateStatus: 'DIRTY' }) },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('dry-run never calls gh pr merge even when eligible', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
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
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason).toMatch(/check-run fallback/);
    expect(result.merged).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(true);
  });

  it('AISDLC-620 AC-1 — real no-branch-protection repo (gh --required exits 1 with "no required checks reported"), green + CLEAN → ELIGIBLE via check-run fallback', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
      'gh pr checks 42 --required': {
        code: 1,
        stderr: "no required checks reported on the 'main' branch",
      },
      'gh pr checks 42 --json': {
        stdout: JSON.stringify([
          { name: 'ci', state: 'SUCCESS' },
          { name: 'lint', state: 'NEUTRAL' },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(true);
    expect(result.eligibility.reason).toMatch(/check-run fallback/);
    expect(result.merged).toBe(true);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(true);
  });

  it('AISDLC-620 AC-2 — a genuine required-checks fetch error (NOT the sentinel) on a no-protection-looking exit-1 still REFUSES fail-closed', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
      'gh pr checks 42 --required': {
        code: 1,
        stderr: 'gh: authentication required. run `gh auth login`',
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    // MUST NOT have fallen through to the unfiltered check-runs fetch —
    // a genuine auth/network error is never conflated with "no required
    // checks configured".
    expect(calls.some((c) => c.args.includes('checks') && !c.args.includes('--required'))).toBe(
      false,
    );
    expect(result.merged).toBe(false);
  });

  it('AC-4 — no required contexts, a check-run FAILURE → REFUSES with an auditable reason', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/security-scan=FAILURE/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-4 — no required contexts, a check-run PENDING → REFUSES with an auditable reason', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/slow-integration-test=PENDING/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-5 — the check-run fetch itself errors → REFUSES (fail-closed), NOT treated as vacuously green', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    expect(result.merged).toBe(false);
    expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('AC-5 — the REQUIRED-checks fetch itself errors (not merely empty) → REFUSES without falling back to check-runs', async () => {
    const { runner, calls } = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
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
      'gh pr view 42': { stdout: prView() },
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
      loadMergeAuthors: () => ['operator'],
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
