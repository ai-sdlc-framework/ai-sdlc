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

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateMergeEligibility,
  fetchMergeStateStatus,
  fetchRequiredChecks,
  isTrustedSourceKind,
  loadGovernanceResolverModule,
  mergePr,
  resolveRepoGovernancePolicy,
  resolveRepoSlug,
  runMergeIfEligible,
  STRICT_DEFAULTS,
  type GovernancePolicy,
} from './merge-if-eligible.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

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

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed to STRICT_DEFAULTS when the resolver module cannot be located', () => {
    dir = mkdtempSync(join(tmpdir(), 'aisdlc-603-'));
    const policy = resolveRepoGovernancePolicy(dir, join(dir, 'nonexistent-pkg-root'));
    expect(policy).toEqual(STRICT_DEFAULTS);
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
  it('resolves the real AISDLC-601 resolver from this monorepo checkout', () => {
    // pipeline-cli/src/governance/merge-if-eligible.test.ts → pkgRoot is
    // pipeline-cli/ itself (two levels up from this file at runtime via
    // import.meta.url in the SUT — here we pass it explicitly).
    const pkgRoot = join(__dirname, '..', '..');
    const mod = loadGovernanceResolverModule(pkgRoot);
    expect(mod).not.toBeNull();
    expect(typeof mod?.resolveGovernanceFromYaml).toBe('function');
  });

  it('returns null for a pkgRoot with no sibling ai-sdlc-plugin', () => {
    const mod = loadGovernanceResolverModule('/tmp/definitely-not-a-real-monorepo-root');
    expect(mod).toBeNull();
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
    const checks = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(checks).toEqual([
      { name: 'ci', state: 'SUCCESS' },
      { name: 'verify-attestation', state: 'SUCCESS' },
      { name: 'migration-mutation-gate', state: 'PENDING' },
    ]);
  });

  it('returns [] on gh failure (fail-closed downstream)', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': { code: 1, stderr: 'not found' },
    });
    const checks = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(checks).toEqual([]);
  });

  it('returns [] on unparseable JSON', async () => {
    const { runner } = makeFakeRunner({
      'gh pr checks 42 --required': { stdout: 'not json' },
    });
    const checks = await fetchRequiredChecks(42, 'org/repo', runner);
    expect(checks).toEqual([]);
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
});
