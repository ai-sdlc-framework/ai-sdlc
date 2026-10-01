/**
 * Hermetic tests for the `merge-if-eligible` deterministic core
 * (RFC-0048 Phase 3). No real `gh` calls: every test drives a `FakeRunner`;
 * the policy-from-git and verified-root tests use real git in temp dirs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveTaskId,
  evaluateMergeEligibility,
  evaluatePrTrust,
  governanceSensitiveChanges,
  isGovernanceSensitivePath,
  fetchCommitLogins,
  fetchPrSnapshot,
  fetchRequiredChecks,
  fetchShaChecks,
  isBacklogTaskFileFor,
  isTrustedSourceKind,
  parseGovernanceBlock,
  readFileFromMain,
  readTaskPrefix,
  resolveMainSha,
  resolveGovernanceFromYaml,
  resolveRepoSlug,
  resolveTrustedMainRoot,
  runMergeIfEligible,
  STRICT_DEFAULTS,
  stateForRequired,
  taskFileOnMain,
  verifiedMainRoot,
  type GovernancePolicy,
  type PrSnapshot,
  type RunMergeIfEligibleOptions,
} from './merge-if-eligible.js';
import { type ExecResult, type Runner } from '../runtime/exec.js';

const ORIGINAL_ENV = { ...process.env };

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
const GREEN_YAML =
  'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [operator]\n';
const NEVER_YAML = 'spec:\n  governance:\n    allowMerge: never\n    mergeAuthors: [operator]\n';

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

type Run = [name: string, status: string, conclusion: string | null];

/** Handlers for the head-commit check runs + statuses queries (one JSON object per line). */
function shaChecks(
  sha: string,
  runs: Run[],
  statuses: Array<[string, string]> = [],
): Record<string, Partial<ExecResult>> {
  const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n');
  return {
    [`commits/${sha}/check-runs`]: {
      stdout: lines(runs.map(([name, status, conclusion]) => ({ name, status, conclusion }))),
    },
    [`commits/${sha}/status`]: {
      stdout: lines(statuses.map(([context, state]) => ({ context, state }))),
    },
  };
}

const SHA_BACKLOG = '1'.repeat(40);
const SHA_TASKS = '2'.repeat(40);
const SHA_COMPLETED = '3'.repeat(40);

/** Handlers for the git-trees walk main -> backlog -> tasks/completed (names are file names). */
function treeHandlers(
  names: { tasks?: string[]; completed?: string[] },
  opts: { truncatedDir?: 'root' | 'backlog' | 'tasks' | 'completed' } = {},
): Record<string, Partial<ExecResult>> {
  const tree = (entries: Array<[string, string, string]>, dir: string) =>
    JSON.stringify({
      truncated: opts.truncatedDir === dir,
      tree: entries.map(([path, type, sha]) => ({ path, type, sha })),
    });
  const blobs = (xs: string[] = []) =>
    xs.map((n): [string, string, string] => [n, 'blob', '4'.repeat(40)]);
  return {
    [`git/trees/${MAIN_SHA} --jq`]: {
      stdout: tree(
        [
          ['backlog', 'tree', SHA_BACKLOG],
          ['README.md', 'blob', '5'.repeat(40)],
        ],
        'root',
      ),
    },
    [`git/trees/${SHA_BACKLOG} --jq`]: {
      stdout: tree(
        [
          ['tasks', 'tree', SHA_TASKS],
          ['completed', 'tree', SHA_COMPLETED],
        ],
        'backlog',
      ),
    },
    [`git/trees/${SHA_TASKS} --jq`]: { stdout: tree(blobs(names.tasks), 'tasks') },
    [`git/trees/${SHA_COMPLETED} --jq`]: { stdout: tree(blobs(names.completed), 'completed') },
  };
}

const MAIN_SHA = 'c'.repeat(40);

/** `git/ref/heads/main` answer: the main BRANCH resolved to one commit. */
const MAIN_REF: Record<string, Partial<ExecResult>> = {
  'git/ref/heads/main': { stdout: JSON.stringify({ type: 'commit', sha: MAIN_SHA }) },
};

type Changed = [filename: string, status?: string, previous?: string];

/** `pulls/<n>/files` answer (one JSON object per line, as `--paginate --jq` prints). */
function changedFiles(list: Changed[]): Record<string, Partial<ExecResult>> {
  return {
    'pulls/42/files': {
      stdout: list
        .map(([filename, status = 'added', previous]) =>
          JSON.stringify({ filename, status, previous_filename: previous }),
        )
        .join('\n'),
    },
  };
}

const CLEAN_FILES = changedFiles([
  ['backlog/completed/aisdlc-9 - do the thing.md'],
  ['pipeline-cli/src/foo.ts', 'modified'],
]);

const COMMIT_OPERATOR = {
  [`commits/${HEAD_A} --jq {author`]: {
    stdout: JSON.stringify({ author: 'operator', committer: 'operator' }),
  },
};

// ── evaluateMergeEligibility (pure) ──────────────────────────────────

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

describe('resolveRepoSlug', () => {
  it('parses the repo slug', async () => {
    const { runner } = makeFakeRunner({ 'gh repo view': { stdout: 'org/repo\n' } });
    expect(await resolveRepoSlug(runner)).toBe('org/repo');
  });

  it('returns null (never throws) on gh failure or an implausible slug', async () => {
    const failing = makeFakeRunner({ 'gh repo view': { code: 1, stderr: 'not a repo' } });
    expect(await resolveRepoSlug(failing.runner)).toBeNull();
    const garbage = makeFakeRunner({ 'gh repo view': { stdout: 'two words\n' } });
    expect(await resolveRepoSlug(garbage.runner)).toBeNull();
  });
});

describe('fetchShaChecks (bound to the exact head commit)', () => {
  it('maps check runs and statuses of THAT sha, reading every page', async () => {
    const { runner, calls } = makeFakeRunner(
      shaChecks(
        HEAD_A,
        [
          ['ci', 'completed', 'success'],
          ['lint', 'completed', 'neutral'],
          ['slow', 'in_progress', null],
          ['broken', 'completed', 'failure'],
          ['odd', 'completed', null],
        ],
        [['legacy/ci', 'success']],
      ),
    );
    const res = await fetchShaChecks(HEAD_A, 'org/repo', runner);
    expect(res.fetchFailed).toBe(false);
    expect(res.checks).toEqual([
      { name: 'ci', state: 'SUCCESS' },
      { name: 'lint', state: 'NEUTRAL' },
      { name: 'slow', state: 'PENDING' },
      { name: 'broken', state: 'FAILURE' },
      { name: 'odd', state: 'UNKNOWN' },
      { name: 'legacy/ci', state: 'SUCCESS' },
    ]);
    expect(calls.map((c) => c.args[1])).toEqual([
      `repos/org/repo/commits/${HEAD_A}/check-runs?per_page=100`,
      `repos/org/repo/commits/${HEAD_A}/status?per_page=100`,
    ]);
    expect(calls.every((c) => c.args.includes('--paginate'))).toBe(true);
  });

  it('handles more than one page (150 check runs) without refusing', async () => {
    const many = Array.from({ length: 150 }, (_, i): Run => [`job-${i}`, 'completed', 'success']);
    const res = await fetchShaChecks(
      HEAD_A,
      'org/repo',
      makeFakeRunner(shaChecks(HEAD_A, many)).runner,
    );
    expect(res.fetchFailed).toBe(false);
    expect(res.checks).toHaveLength(150);
  });

  it('fails closed on gh errors and malformed output', async () => {
    const base = shaChecks(HEAD_A, [['ci', 'completed', 'success']]);
    const bad = (patch: Record<string, Partial<ExecResult>>) =>
      fetchShaChecks(HEAD_A, 'org/repo', makeFakeRunner({ ...base, ...patch }).runner);
    expect((await bad({ [`commits/${HEAD_A}/check-runs`]: { code: 1 } })).fetchFailed).toBe(true);
    expect((await bad({ [`commits/${HEAD_A}/status`]: { code: 1 } })).fetchFailed).toBe(true);
    expect((await bad({ [`commits/${HEAD_A}/check-runs`]: { stdout: 'nope' } })).fetchFailed).toBe(
      true,
    );
    expect((await bad({ [`commits/${HEAD_A}/status`]: { stdout: '{"x":1}' } })).fetchFailed).toBe(
      true,
    );
    expect(
      (
        await bad({
          [`commits/${HEAD_A}/check-runs`]: { stdout: '{"name":"a","status":"x"}\nbroken' },
        })
      ).fetchFailed,
    ).toBe(true);
  });
});

describe('stateForRequired', () => {
  it('is MISSING when absent, SUCCESS when all match green, else the first non-green state', () => {
    const results = [
      { name: 'ci', state: 'SUCCESS' },
      { name: 'dup', state: 'SUCCESS' },
      { name: 'dup', state: 'FAILURE' },
    ];
    expect(stateForRequired('nope', results)).toBe('MISSING');
    expect(stateForRequired('ci', results)).toBe('SUCCESS');
    expect(stateForRequired('dup', results)).toBe('FAILURE');
  });
});

describe('fetchCommitLogins', () => {
  it('reads author and committer logins for the exact sha, null when unlinked', async () => {
    const { runner, calls } = makeFakeRunner({
      [`commits/${HEAD_A} --jq {author`]: { stdout: '{"author":"operator","committer":null}' },
    });
    expect(await fetchCommitLogins(HEAD_A, 'org/repo', runner)).toEqual({
      author: 'operator',
      committer: null,
    });
    expect(calls[0].args[1]).toBe(`repos/org/repo/commits/${HEAD_A}`);
  });

  it('returns null on gh failure or unparseable output', async () => {
    const f = makeFakeRunner({ 'commits/': { code: 1 } });
    expect(await fetchCommitLogins(HEAD_A, 'org/repo', f.runner)).toBeNull();
    const g = makeFakeRunner({ 'commits/': { stdout: 'x' } });
    expect(await fetchCommitLogins(HEAD_A, 'org/repo', g.runner)).toBeNull();
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
    expect(deriveTaskId('feature/foo', 'fix: a').taskId).toBeNull();
  });

  it('accepts only the repo backlog id shape: issue-N and gh-issue-N never qualify', () => {
    expect(deriveTaskId('ai-sdlc/issue-12', 'fix: a').taskId).toBeNull();
    expect(deriveTaskId('ai-sdlc/gh-issue-12-x', 'fix: a (gh-issue-12)').taskId).toBeNull();
    expect(deriveTaskId('ai-sdlc/other-5-x', 'fix: a (OTHER-5)').taskId).toBeNull();
    // A different configured prefix is honoured, the default one is not.
    expect(deriveTaskId('ai-sdlc/proj-5-x', 'fix: a', 'PROJ').taskId).toBe('proj-5');
    expect(deriveTaskId('ai-sdlc/aisdlc-5-x', 'fix: a', 'PROJ').taskId).toBeNull();
  });

  it('matches only backlog/{tasks,completed}/<id> - <slug>.md (id is not a prefix of another id)', () => {
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-9 - x.md')).toBe(true);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/completed/AISDLC-9 - x.md')).toBe(true);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-90 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/tasks/aisdlc-9.1 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'backlog/other/aisdlc-9 - x.md')).toBe(false);
    expect(isBacklogTaskFileFor('aisdlc-9', 'docs/backlog/tasks/aisdlc-9 - x.md')).toBe(false);
  });
});

describe('readFileFromMain + readTaskPrefix + taskFileOnMain (GitHub is authoritative)', () => {
  it('reads main through the contents API with the raw media type (no local git)', async () => {
    const { runner, calls } = makeFakeRunner({ 'contents/a/b.yaml': { stdout: 'text' } });
    expect(await readFileFromMain('org/repo', MAIN_SHA, 'a/b.yaml', runner)).toBe('text');
    expect(calls).toEqual([
      {
        command: 'gh',
        args: [
          'api',
          '-H',
          'Accept: application/vnd.github.raw',
          `repos/org/repo/contents/a/b.yaml?ref=${MAIN_SHA}`,
        ],
      },
    ]);
  });

  it('returns null on any gh failure or an empty body (fail closed)', async () => {
    const f = makeFakeRunner({ 'contents/': { code: 1, stderr: 'HTTP 404' } });
    expect(await readFileFromMain('org/repo', MAIN_SHA, 'a', f.runner)).toBeNull();
    const e = makeFakeRunner({ 'contents/': { stdout: '  \n' } });
    expect(await readFileFromMain('org/repo', MAIN_SHA, 'a', e.runner)).toBeNull();
  });

  it('reads task_prefix from backlog/config.yml and defaults to AISDLC', async () => {
    const ok = makeFakeRunner({ 'config.yml': { stdout: "x: 1\ntask_prefix: 'PROJ'\n" } });
    expect(await readTaskPrefix('org/repo', MAIN_SHA, ok.runner)).toBe('PROJ');
    const none = makeFakeRunner({ 'config.yml': { stdout: 'x: 1\n' } });
    expect(await readTaskPrefix('org/repo', MAIN_SHA, none.runner)).toBe('AISDLC');
    const missing = makeFakeRunner({ 'config.yml': { code: 1 } });
    expect(await readTaskPrefix('org/repo', MAIN_SHA, missing.runner)).toBe('AISDLC');
  });

  it('finds a task file in backlog/tasks or backlog/completed via the trees API', async () => {
    const h = treeHandlers({ tasks: ['aisdlc-10 - other.md'], completed: ['aisdlc-9 - done.md'] });
    expect(await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      true,
    );
    expect(await taskFileOnMain('aisdlc-10', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      true,
    );
    expect(await taskFileOnMain('aisdlc-11', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      false,
    );
    expect(await taskFileOnMain('aisdlc-1', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      false,
    );
  });

  it('fails closed on any tree failure, truncation or missing backlog directory', async () => {
    const names = { completed: ['aisdlc-9 - done.md'] };
    for (const dir of ['root', 'backlog', 'tasks', 'completed'] as const) {
      const h = treeHandlers(names, { truncatedDir: dir });
      expect(await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
        false,
      );
    }
    for (const key of [
      `git/trees/${MAIN_SHA} --jq`,
      `git/trees/${SHA_BACKLOG} --jq`,
      `git/trees/${SHA_COMPLETED} --jq`,
    ]) {
      const h = { ...treeHandlers(names), [key]: { code: 1 } };
      expect(await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
        false,
      );
    }
    const garbage = {
      ...treeHandlers(names),
      [`git/trees/${MAIN_SHA} --jq`]: { stdout: 'not json' },
    };
    expect(
      await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(garbage).runner),
    ).toBe(false);
    const noTree = {
      ...treeHandlers(names),
      [`git/trees/${MAIN_SHA} --jq`]: { stdout: '{"truncated":false}' },
    };
    expect(
      await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(noTree).runner),
    ).toBe(false);
    const noBacklog = {
      ...treeHandlers(names),
      [`git/trees/${MAIN_SHA} --jq`]: { stdout: '{"truncated":false,"tree":[]}' },
    };
    expect(
      await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(noBacklog).runner),
    ).toBe(false);
  });

  it('a file (blob) named backlog is not a directory and refuses', async () => {
    const h = {
      ...treeHandlers({ completed: ['aisdlc-9 - done.md'] }),
      [`git/trees/${MAIN_SHA} --jq`]: {
        stdout: JSON.stringify({
          truncated: false,
          tree: [{ path: 'backlog', type: 'blob', sha: SHA_BACKLOG }],
        }),
      },
    };
    expect(await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      false,
    );
  });

  it('a backlog tree without a tasks directory still checks completed', async () => {
    const h = {
      ...treeHandlers({ completed: ['aisdlc-9 - done.md'] }),
      [`git/trees/${SHA_BACKLOG} --jq`]: {
        stdout: JSON.stringify({
          truncated: false,
          tree: [{ path: 'completed', type: 'tree', sha: SHA_COMPLETED }],
        }),
      },
    };
    expect(await taskFileOnMain('aisdlc-9', 'org/repo', MAIN_SHA, makeFakeRunner(h).runner)).toBe(
      true,
    );
  });
});

describe('evaluatePrTrust (GitHub-derived trust facts)', () => {
  async function trust(
    overrides: Partial<PrSnapshot>,
    opts: {
      authors?: string[];
      tasks?: string[];
      completed?: string[];
      treesFail?: boolean;
      commit?: Partial<ExecResult>;
    } = {},
  ) {
    const { runner, calls } = makeFakeRunner({
      ...(opts.treesFail
        ? { 'git/trees/': { code: 1 } }
        : treeHandlers({
            tasks: opts.tasks ?? ['aisdlc-10 - other.md'],
            completed: opts.completed ?? ['aisdlc-9 - do the thing.md'],
          })),
      'commits/': opts.commit ?? { stdout: '{"author":"operator","committer":"operator"}' },
    });
    const reason = await evaluatePrTrust({
      snapshot: { ...SNAPSHOT, ...overrides },
      mergeAuthors: opts.authors ?? ['operator'],
      repoSlug: 'org/repo',
      taskPrefix: 'AISDLC',
      mainSha: async () => MAIN_SHA,
      runner,
    });
    return { reason, calls };
  }

  it('passes for a same-repo, main-based, allow-listed PR whose task is on main (per GitHub)', async () => {
    const { reason, calls } = await trust({});
    expect(reason).toBeNull();
    expect(calls[0].args.slice(0, 2)).toEqual(['api', `repos/org/repo/git/trees/${MAIN_SHA}`]);
    expect(calls.every((c) => c.command === 'gh')).toBe(true);
  });

  it('refuses a fork PR (isCrossRepository !== false)', async () => {
    expect((await trust({ isCrossRepository: true })).reason).toMatch(/fork/);
  });

  it('refuses an author who is not on the allow-list, and compares logins case-insensitively', async () => {
    expect((await trust({ authorLogin: 'mallory' })).reason).toMatch(/not on the .*mergeAuthors/);
    expect((await trust({ authorLogin: 'OPERATOR' })).reason).toBeNull();
  });

  it('refuses when the allow-list is empty (fail closed), without any call', async () => {
    const { reason, calls } = await trust({}, { authors: [] });
    expect(reason).toMatch(/empty list trusts nobody/);
    expect(calls).toEqual([]);
  });

  it('refuses a non-main base branch', async () => {
    expect((await trust({ baseRefName: 'release/1.x' })).reason).toMatch(/base branch/);
  });

  it('refuses when no backlog task exists on main or in the PR diff', async () => {
    const { reason } = await trust({
      headRefName: 'ai-sdlc/aisdlc-77-nope',
      title: 'x (AISDLC-77)',
    });
    expect(reason).toMatch(/no backlog task file for "aisdlc-77"/);
  });

  it('refuses when the trees API fails (cannot prove the task exists)', async () => {
    expect((await trust({}, { treesFail: true })).reason).toMatch(/no backlog task file/);
  });

  it('refuses when the branch/title carry no task id, a gh-issue style id, or disagree', async () => {
    expect((await trust({ headRefName: 'feature/x', title: 'no id' })).reason).toMatch(
      /no backlog task id/,
    );
    expect((await trust({ headRefName: 'ai-sdlc/gh-issue-12-x', title: 'x' })).reason).toMatch(
      /no backlog task id/,
    );
    expect((await trust({ title: 'x (AISDLC-10)' })).reason).toMatch(/ambiguous task id/);
  });

  it('accepts a task file added by the PR own diff without a trees call', async () => {
    const { reason, calls } = await trust(
      {
        headRefName: 'ai-sdlc/aisdlc-77-new',
        title: 'x (AISDLC-77)',
        files: [{ path: 'backlog/completed/aisdlc-77 - new.md', changeType: 'ADDED' }],
      },
      { tasks: [], completed: [] },
    );
    expect(reason).toBeNull();
    expect(calls.some((c) => String(c.args[1]).includes('git/trees'))).toBe(false);
  });

  it('does not count a task file the PR deletes, nor an unrelated PR file', async () => {
    const base = { headRefName: 'ai-sdlc/aisdlc-77-new', title: 'x (AISDLC-77)' };
    for (const f of [
      { path: 'backlog/tasks/aisdlc-77 - new.md', changeType: 'DELETED' },
      { path: 'src/aisdlc-77 - new.md', changeType: 'ADDED' },
    ]) {
      expect((await trust({ ...base, files: [f] }, { tasks: [], completed: [] })).reason).toMatch(
        /no backlog task file/,
      );
    }
  });

  it('requires the head commit author login (resolved for the exact sha) on the allow-list', async () => {
    const other = await trust(
      {},
      { commit: { stdout: '{"author":"mallory","committer":"operator"}' } },
    );
    expect(other.reason).toMatch(/head commit author "mallory" is not on/);
    const unlinked = await trust(
      {},
      { commit: { stdout: '{"author":null,"committer":"operator"}' } },
    );
    expect(unlinked.reason).toMatch(/not linked to a GitHub account/);
    const failed = await trust({}, { commit: { code: 1 } });
    expect(failed.reason).toMatch(/could not read the head commit author/);
    const upper = await trust({}, { commit: { stdout: '{"author":"OPERATOR","committer":null}' } });
    expect(upper.reason).toBeNull();
  });
});

// ── Native governance resolution ─────────────────────────────────────

describe('resolveGovernanceFromYaml (native)', () => {
  it('fails closed to strict with no authors when the block is absent', () => {
    expect(resolveGovernanceFromYaml('spec:\n  role: x\n')).toEqual({
      policy: STRICT_DEFAULTS,
      mergeAuthors: [],
    });
    expect(parseGovernanceBlock('spec:\n  role: x\n')).toBeNull();
  });

  it('reads allowMerge, preset and the allow-list (block and inline lists, comments)', () => {
    const block =
      'spec:\n  governance:\n    allowMerge: onGreenClean\n    # note\n    mergeAuthors:\n      - octocat # me\n      - "Hub-Bot9"\n    allowResetHard: true\n  other: 1\n';
    const r = resolveGovernanceFromYaml(block);
    expect(r.policy.allowMerge).toBe('onGreenClean');
    expect(r.policy.allowResetHard).toBe(true);
    expect(r.mergeAuthors).toEqual(['octocat', 'Hub-Bot9']);
    const inline =
      'governance:\n  preset: operator-trusted\n  mergeAuthors: [a1, b-2]\n  allowForcePush: leaseOnOwnBranch\n';
    const i = resolveGovernanceFromYaml(inline);
    expect(i.policy.allowMerge).toBe('onGreenClean');
    expect(i.policy.allowForcePush).toBe(true);
    expect(i.mergeAuthors).toEqual(['a1', 'b-2']);
    expect(
      resolveGovernanceFromYaml('governance:\n  allowForcePush: never\n').policy.allowForcePush,
    ).toBe(false);
  });

  it('ignores malformed values and drops malformed or duplicate logins', () => {
    const r = resolveGovernanceFromYaml(
      'governance:\n  allowMerge: always\n  preset: nope\n  allowResetHard: maybe\n  mergeAuthors: [ok, OK, -bad, bad-, a--b, "x y", ' +
        'z'.repeat(40) +
        ']\n  operational:\n    - requeue\n  mergeAuthorsScalar: x\n',
    );
    expect(r.policy).toEqual(STRICT_DEFAULTS);
    expect(r.mergeAuthors).toEqual(['ok']);
    expect(
      resolveGovernanceFromYaml('governance:\n  mergeAuthors: octocat\n').mergeAuthors,
    ).toEqual(['octocat']);
    expect(resolveGovernanceFromYaml('governance:\n  mergeAuthors:\n').mergeAuthors).toEqual([]);
  });

  it('agrees with the plugin resolver on policy and allow-list for the same text', () => {
    const require = createRequire(import.meta.url);
    const plugin = require(
      join(__dirname, '..', '..', '..', 'ai-sdlc-plugin', 'hooks', 'lib', 'governance-resolver.js'),
    ) as {
      resolveGovernanceFromYaml(t: string): GovernancePolicy;
      resolveMergeAuthorsFromYaml(t: string): string[];
    };
    for (const yaml of [
      '',
      GREEN_YAML,
      NEVER_YAML,
      'governance:\n  preset: operator-trusted\n  allowMerge: never\n',
      'governance:\n  allowForcePush: true\n  allowBranchDelete: true\n  mergeAuthors:\n    - a\n    - A\n    - b-c\n',
      'governance:\n  allowMerge: bogus\n  mergeAuthors: [-x, y]\n',
    ]) {
      const native = resolveGovernanceFromYaml(yaml);
      expect(native.policy).toEqual(plugin.resolveGovernanceFromYaml(yaml));
      expect(native.mergeAuthors).toEqual(plugin.resolveMergeAuthorsFromYaml(yaml));
    }
  });
});

// ── Verified main checkout + policy from git ─────────────────────────

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

/** A repo whose committed policy is `policy`; `refs/remotes/origin/main` points at it. */
function initRepo(root: string, policy: string): void {
  mkdirSync(root, { recursive: true });
  git(['init', '-q', '-b', 'main'], root);
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), policy);
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
}

describe('verified main root + policy read from git', () => {
  let base: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aisdlc-663-5-root-'));
    main = join(base, 'main');
    initRepo(main, NEVER_YAML);
    worktree = join(main, '.worktrees', 'aisdlc-9');
    git(['worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-9-x', worktree], main);
    mkdirSync(join(worktree, 'pipeline-cli'), { recursive: true });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(base, { recursive: true, force: true });
  });

  const real = (p: string | null) => (p ? realpathSync(p) : p);

  it('verifiedMainRoot resolves the main checkout from a worktree and refuses non-repos and odd layouts', () => {
    expect(real(verifiedMainRoot(worktree))).toBe(realpathSync(main));
    expect(real(verifiedMainRoot(main))).toBe(realpathSync(main));
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(verifiedMainRoot(plain)).toBeNull();
    // A symlinked .git is refused.
    const linked = join(base, 'linked');
    mkdirSync(linked);
    symlinkSync(join(main, '.git'), join(linked, '.git'));
    expect(verifiedMainRoot(linked)).toBeNull();
    // A bare layout (common dir not named .git) is refused.
    expect(verifiedMainRoot(main, () => join(base, 'main.git'))).toBeNull();
    expect(verifiedMainRoot(main, () => null)).toBeNull();
    // A reported common dir that does not exist on disk is refused (lstat fails).
    expect(verifiedMainRoot(main, () => join(base, 'missing', '.git'))).toBeNull();
  });

  it('resolveTrustedMainRoot: worktree CLI + worktree cwd resolve to the MAIN checkout', () => {
    const res = resolveTrustedMainRoot({
      cwd: worktree,
      anchorDir: join(worktree, 'pipeline-cli'),
    });
    expect(real(res.root)).toBe(realpathSync(main));
  });

  it('refuses when cwd belongs to a DIFFERENT repo than the CLI, or either is not a checkout', () => {
    const evil = join(base, 'evil');
    initRepo(evil, GREEN_YAML);
    const anchorDir = join(worktree, 'pipeline-cli');
    const r = resolveTrustedMainRoot({ cwd: evil, anchorDir });
    expect(r.root).toBeNull();
    expect(r.reason).toMatch(/same verified main checkout/);
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(resolveTrustedMainRoot({ cwd: main, anchorDir: plain }).reason).toMatch(
      /containing this CLI/,
    );
    expect(resolveTrustedMainRoot({ cwd: plain, anchorDir }).root).toBeNull();
  });

  it('no environment variable (old override name, plugin root/dir) changes the trusted root', () => {
    const attacker = join(base, 'attacker');
    initRepo(attacker, GREEN_YAML);
    process.env['AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS'] = '1';
    process.env['CLAUDE_PLUGIN_ROOT'] = attacker;
    process.env['CLAUDE_PLUGIN_DIR'] = attacker;
    process.env['GIT_DIR'] = join(attacker, '.git');
    const anchorDir = join(worktree, 'pipeline-cli');
    expect(real(resolveTrustedMainRoot({ cwd: worktree, anchorDir }).root)).toBe(
      realpathSync(main),
    );
    expect(resolveTrustedMainRoot({ cwd: attacker, anchorDir }).root).toBeNull();
  });

  it('git environment variables cannot redirect the root verification', () => {
    const attacker = join(base, 'attacker');
    initRepo(attacker, GREEN_YAML);
    process.env['GIT_COMMON_DIR'] = join(attacker, '.git');
    process.env['GIT_OBJECT_DIRECTORY'] = join(attacker, '.git', 'objects');
    process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = join(attacker, '.git', 'objects');
    process.env['GIT_REPLACE_REF_BASE'] = 'refs/forged/';
    process.env['GIT_WORK_TREE'] = attacker;
    expect(real(verifiedMainRoot(worktree))).toBe(realpathSync(main));
    expect(real(verifiedMainRoot(main))).toBe(realpathSync(main));
  });

  // The policy is authoritative from GitHub: a forged local origin/main ref, a worktree
  // copy and an uncommitted edit have no say, and nothing is ever read through local git.
  const apiPolicy = (yaml: string | null) =>
    yaml === null
      ? { ...MAIN_REF, 'contents/.ai-sdlc/agent-role.yaml': { code: 1, stderr: 'HTTP 404' } }
      : { ...MAIN_REF, 'contents/.ai-sdlc/agent-role.yaml': { stdout: yaml } };

  it('API says never: refused even though a forged local origin/main and worktree copy say onGreenClean', async () => {
    writeFileSync(join(main, '.ai-sdlc', 'agent-role.yaml'), GREEN_YAML);
    git(['commit', '-qam', 'forged grant'], main);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], main);
    writeFileSync(join(worktree, '.ai-sdlc', 'agent-role.yaml'), GREEN_YAML);
    const { runner, calls } = makeFakeRunner(apiPolicy(NEVER_YAML));
    const result = await runMergeIfEligible({
      prNumber: 9,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: main,
      runner,
    });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reason).toMatch(/allowMerge="never"/);
    expect(calls).toHaveLength(2); // main ref + API policy read; no git, no PR read
    expect(calls[0].command).toBe('gh');
  });

  it('API says onGreenClean: honoured even though local refs and files say never', async () => {
    const { runner } = makeFakeRunner({ ...apiPolicy(GREEN_YAML), 'gh pr view': { code: 1 } });
    const result = await runMergeIfEligible({
      prNumber: 9,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: main,
      runner,
    });
    expect(result.eligibility.reason).toMatch(/could not read the PR/);
  });

  it('an API failure (404, error, empty body) refuses and spends no PR call', async () => {
    for (const handlers of [
      apiPolicy(null),
      { ...MAIN_REF, 'contents/.ai-sdlc/agent-role.yaml': { stdout: '' } },
    ]) {
      const { runner, calls } = makeFakeRunner(handlers);
      const result = await runMergeIfEligible({
        prNumber: 9,
        sourceKind: 'backlog',
        repoSlug: 'org/repo',
        repoRoot: main,
        runner,
      });
      expect(result.eligibility.reason).toMatch(
        /could not read \.ai-sdlc\/agent-role\.yaml from main/,
      );
      expect(calls).toHaveLength(2);
    }
  });

  it('mergeAuthors come only from the API copy, never from a local file', async () => {
    writeFileSync(
      join(main, '.ai-sdlc', 'agent-role.yaml'),
      'governance:\n  allowMerge: onGreenClean\n  mergeAuthors: [mallory]\n',
    );
    const { runner } = makeFakeRunner({
      ...apiPolicy(GREEN_YAML), // allow-list: operator only
      'gh pr view 42': { stdout: prView({ author: { login: 'mallory' } }) },
    });
    const result = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: main,
      runner,
      taskPrefix: 'AISDLC',
    });
    expect(result.eligibility.reason).toMatch(/"mallory" is not on the/);
  });

  it('a revocation on main applies on the very next run (no local fetch involved)', async () => {
    let policy = GREEN_YAML;
    const runner: Runner = async (_c, args) => {
      if (String(args.join(' ')).includes('git/ref/heads/main')) {
        return { stdout: MAIN_REF['git/ref/heads/main'].stdout ?? '', stderr: '', code: 0 };
      }
      if (String(args.join(' ')).includes('contents/.ai-sdlc/agent-role.yaml')) {
        return { stdout: policy, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'x', code: 1 }; // PR read fails -> proves the grant was honoured
    };
    const run = () =>
      runMergeIfEligible({
        prNumber: 9,
        sourceKind: 'backlog',
        repoSlug: 'org/repo',
        repoRoot: main,
        runner,
      });
    expect((await run()).eligibility.reason).toMatch(/could not read the PR/);
    policy = NEVER_YAML;
    expect((await run()).eligibility.reason).toMatch(/allowMerge="never"/);
  });
});

describe('runMergeIfEligible — hardened trust + head pin', () => {
  const ALL_OK: Record<string, Partial<ExecResult>> = {
    'gh pr view 42': { stdout: prView() },
    ...MAIN_REF,
    ...CLEAN_FILES,
    'gh pr checks 42 --required': { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]) },
    ...COMMIT_OPERATOR,
    ...shaChecks(HEAD_A, [['ci', 'completed', 'success']]),
    'gh pr merge 42': {},
  };

  function run(
    handlers: Record<string, Partial<ExecResult> | Error>,
    extra: Partial<RunMergeIfEligibleOptions> = {},
  ) {
    const fake = makeFakeRunner(handlers);
    const promise = runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner: fake.runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
      ...extra,
    });
    return { promise, calls: fake.calls };
  }
  const mergeCalls = (calls: RecordedCall[]) => calls.filter((c) => c.args.includes('merge'));

  it('refuses under strict policy / untrusted sourceKind / no root / unreadable policy, spending no gh call', async () => {
    for (const extra of [
      { policyYaml: NEVER_YAML },
      { sourceKind: 'gh-issue' as const },
      { repoRoot: null, rootRefusal: 'because' },
      { policyYaml: null },
    ]) {
      const { promise, calls } = run({}, extra);
      const r = await promise;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.merged).toBe(false);
      expect(calls).toEqual([]);
    }
    const noRoot = await run({}, { repoRoot: null, rootRefusal: 'because' }).promise;
    expect(noRoot.eligibility.reason).toMatch(/verified main checkout.*because/);
    expect(noRoot.policy).toEqual(STRICT_DEFAULTS);
  });

  it('resolves main to one SHA, then reads the policy at that SHA via the contents API', async () => {
    const { promise, calls } = run(
      { ...ALL_OK, 'contents/.ai-sdlc/agent-role.yaml': { stdout: GREEN_YAML } },
      { policyYaml: undefined },
    );
    expect((await promise).merged).toBe(true);
    expect(calls[0].args).toEqual([
      'api',
      'repos/org/repo/git/ref/heads/main',
      '--jq',
      '{type: .object.type, sha: .object.sha}',
    ]);
    expect(calls[1]).toEqual({
      command: 'gh',
      args: [
        'api',
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/org/repo/contents/.ai-sdlc/agent-role.yaml?ref=${MAIN_SHA}`,
      ],
    });
    expect(calls.every((c) => c.command === 'gh')).toBe(true);
  });

  it('reads the task prefix from main via GitHub when not injected', async () => {
    const { promise, calls } = run(
      { ...ALL_OK, 'contents/backlog/config.yml': { stdout: 'task_prefix: AISDLC\n' } },
      { taskPrefix: undefined },
    );
    expect((await promise).merged).toBe(true);
    expect(calls.some((c) => String(c.args.at(-1)).includes('contents/backlog/config.yml'))).toBe(
      true,
    );
  });

  it('merges when green + CLEAN + trusted, pinned to the head commit, in the expected order', async () => {
    const { promise, calls } = run(ALL_OK);
    const r = await promise;
    expect(r.eligibility.eligible).toBe(true);
    expect(r.merged).toBe(true);
    expect(mergeCalls(calls)[0].args).toEqual(
      expect.arrayContaining(['--match-head-commit', HEAD_A, '--squash']),
    );
    const label = (c: RecordedCall) =>
      c.args[0] === 'api'
        ? String(c.args[1])
            .replace(/^repos\/org\/repo\//, '')
            .split('?')[0]
        : c.args.slice(0, 2).join(' ');
    expect(calls.map(label)).toEqual([
      'pr view',
      `commits/${HEAD_A}`,
      'pulls/42/files',
      'pr checks',
      `commits/${HEAD_A}/check-runs`,
      `commits/${HEAD_A}/status`,
      'pr view',
      'pr merge',
    ]);
  });

  it('refuses a fork PR, the wrong author, an empty allow-list, a non-main base and a missing task', async () => {
    const cases: Array<[Record<string, unknown>, Partial<RunMergeIfEligibleOptions>, RegExp]> = [
      [{ isCrossRepository: true }, {}, /fork/],
      [{ author: { login: 'mallory' } }, {}, /"mallory" is not on the/],
      [{}, { policyYaml: 'governance:\n  allowMerge: onGreenClean\n' }, /mergeAuthors/],
      [{ baseRefName: 'dev' }, {}, /base branch is "dev"/],
      [{ files: [] }, {}, /no backlog task file for "aisdlc-9"/],
    ];
    for (const [pr, extra, re] of cases) {
      const { promise, calls } = run(
        { ...ALL_OK, 'gh pr view 42': { stdout: prView(pr) }, ...treeHandlers({}) },
        extra,
      );
      const r = await promise;
      expect(r.eligibility.reason).toMatch(re);
      expect(r.merged).toBe(false);
      expect(mergeCalls(calls)).toEqual([]);
    }
  });

  it('merges when the task exists on main per GitHub (not in the PR diff)', async () => {
    const { promise } = run({
      ...ALL_OK,
      'gh pr view 42': { stdout: prView({ files: [] }) },
      ...treeHandlers({ completed: ['aisdlc-9 - do the thing.md'] }),
    });
    expect((await promise).merged).toBe(true);
  });

  it('refuses when the PR cannot be read in one call', async () => {
    const { promise } = run({ 'gh pr view 42': { code: 1, stderr: 'nope' } });
    expect((await promise).eligibility.reason).toMatch(/could not read the PR/);
  });

  it('refuses when the head commit author is not allow-listed (and spends no checks call)', async () => {
    const { promise, calls } = run({
      ...ALL_OK,
      [`commits/${HEAD_A} --jq {author`]: { stdout: '{"author":"mallory","committer":"operator"}' },
    });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/head commit author "mallory"/);
    expect(calls.some((c) => c.args.includes('checks'))).toBe(false);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('evaluates REQUIRED checks against the head commit: a green current-head report does not hide a failing sha', async () => {
    const { promise, calls } = run({
      ...ALL_OK,
      ...shaChecks(HEAD_A, [['ci', 'completed', 'failure']]),
    });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/ci=FAILURE/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('a required context with no result for the head commit is MISSING and refuses', async () => {
    const { promise } = run({
      ...ALL_OK,
      ...shaChecks(HEAD_A, [['other', 'completed', 'success']]),
    });
    expect((await promise).eligibility.reason).toMatch(/ci=MISSING/);
  });

  it('refuses when the head-commit checks fetch fails or returns malformed output', async () => {
    const failed = await run({ ...ALL_OK, [`commits/${HEAD_A}/status`]: { code: 1 } }).promise;
    expect(failed.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    const garbage = await run({
      ...ALL_OK,
      [`commits/${HEAD_A}/check-runs`]: { stdout: 'not json' },
    }).promise;
    expect(garbage.eligibility.reason).toMatch(/fetch itself failed\/errored/);
  });

  it('no required contexts: every check run and status of the head commit must be green (fallback)', async () => {
    const base = {
      ...ALL_OK,
      'gh pr checks 42 --required': { stdout: '[]' },
    };
    const ok = await run({
      ...base,
      ...shaChecks(
        HEAD_A,
        [
          ['ci', 'completed', 'success'],
          ['lint', 'completed', 'neutral'],
          ['skipped-job', 'completed', 'skipped'],
        ],
        [['legacy', 'success']],
      ),
    }).promise;
    expect(ok.eligibility.reason).toMatch(/check-run fallback/);
    expect(ok.merged).toBe(true);
    // A real no-branch-protection repo: gh exits 1 with the sentinel.
    const sentinel = await run({
      ...base,
      'gh pr checks 42 --required': {
        code: 1,
        stderr: "no required checks reported on the 'main' branch",
      },
    }).promise;
    expect(sentinel.merged).toBe(true);
    for (const [runs, statuses, re] of [
      [[['ci', 'completed', 'failure']], [], /ci=FAILURE/],
      [[['ci', 'in_progress', null]], [], /ci=PENDING/],
      [[['ci', 'completed', 'success']], [['legacy', 'failure']], /legacy=FAILURE/],
      [[], [], /no branch-protection required contexts AND no/],
    ] as Array<[Run[], Array<[string, string]>, RegExp]>) {
      const r = await run({ ...base, ...shaChecks(HEAD_A, runs, statuses) }).promise;
      expect(r.eligibility.reason).toMatch(re);
      expect(r.merged).toBe(false);
    }
  });

  it('a failed REQUIRED-checks fetch refuses without falling back to head-commit check runs', async () => {
    const { promise, calls } = run({
      ...ALL_OK,
      'gh pr checks 42 --required': { code: 1, stderr: 'gh: authentication required' },
    });
    const r = await promise;
    expect(r.eligibility.reason).toMatch(/fetch itself failed\/errored/);
    expect(calls.some((c) => String(c.args[1]).includes('/check-runs'))).toBe(false);
  });

  it('head moved between check and merge: refuses, never calls the merge', async () => {
    let views = 0;
    const calls: RecordedCall[] = [];
    const delegate = makeFakeRunner({ ...ALL_OK, 'gh pr view 42': { stdout: prView() } }).runner;
    const runner: Runner = async (command, args, o) => {
      calls.push({ command, args });
      if (args[1] === 'view') {
        views += 1;
        return {
          stdout: prView({ headRefOid: views === 1 ? HEAD_A : HEAD_B }),
          stderr: '',
          code: 0,
        };
      }
      return delegate(command, args, o);
    };
    const r = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
    });
    expect(r.merged).toBe(false);
    expect(r.eligibility.reason).toMatch(/head moved from a{40} to b{40}/);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it('head moved after the re-read (GitHub refuses the pinned merge): fails closed with a clear reason', async () => {
    const { promise } = run({
      ...ALL_OK,
      'gh pr merge 42': { code: 1, stderr: 'Head branch was modified. Review and try again.' },
    });
    const r = await promise;
    expect(r.merged).toBe(false);
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/refused by GitHub.*Head branch was modified/);
  });

  it('refuses when the pre-merge re-read fails or the PR is no longer CLEAN', async () => {
    for (const [second, re] of [
      [{ code: 1, stdout: '' }, /could not re-read the PR/],
      [{ code: 0, stdout: prView({ mergeStateStatus: 'BEHIND' }) }, /BEHIND.*pre-merge re-read/],
    ] as Array<[Partial<ExecResult>, RegExp]>) {
      let views = 0;
      const delegate = makeFakeRunner(ALL_OK).runner;
      const runner: Runner = async (c, a, o) => {
        if (a[1] === 'view') {
          views += 1;
          return views === 1
            ? { stdout: prView(), stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0, ...second };
        }
        return delegate(c, a, o);
      };
      const r = await runMergeIfEligible({
        prNumber: 42,
        sourceKind: 'backlog',
        repoSlug: 'org/repo',
        repoRoot: '/unused',
        runner,
        policyYaml: GREEN_YAML,
        taskPrefix: 'AISDLC',
      });
      expect(r.merged).toBe(false);
      expect(r.eligibility.reason).toMatch(re);
    }
  });

  it('refuses a non-CLEAN merge state and dry-run never re-reads or merges', async () => {
    const dirty = await run({
      ...ALL_OK,
      'gh pr view 42': { stdout: prView({ mergeStateStatus: 'DIRTY' }) },
    }).promise;
    expect(dirty.eligibility.reason).toMatch(/DIRTY/);
    const { promise, calls } = run(ALL_OK, { dryRun: true });
    const r = await promise;
    expect(r.eligibility.eligible).toBe(true);
    expect(r.merged).toBe(false);
    expect(calls.filter((c) => c.args[1] === 'view')).toHaveLength(1);
    expect(mergeCalls(calls)).toEqual([]);
  });
});

describe('runMergeIfEligible — arm mode (same gate, no green requirement)', () => {
  const ARM_OK: Record<string, Partial<ExecResult>> = {
    'gh pr view 42': { stdout: prView() },
    ...MAIN_REF,
    ...CLEAN_FILES,
    ...COMMIT_OPERATOR,
    'gh pr merge 42': {},
  };

  function runArm(
    handlers: Record<string, Partial<ExecResult> | Error>,
    extra: Partial<RunMergeIfEligibleOptions> = {},
  ) {
    const fake = makeFakeRunner(handlers);
    const promise = runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner: fake.runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
      mode: 'arm',
      ...extra,
    });
    return { promise, calls: fake.calls };
  }
  const armCalls = (calls: RecordedCall[]) => calls.filter((c) => c.args.includes('--auto'));

  it('arms with --auto and --match-head-commit for the checked head, without any checks fetch', async () => {
    const { promise, calls } = runArm(ARM_OK);
    const r = await promise;
    expect(r).toMatchObject({ armed: true, merged: false, dryRun: false });
    expect(r.eligibility.eligible).toBe(true);
    expect(armCalls(calls)[0].args).toEqual([
      'pr',
      'merge',
      '42',
      '--auto',
      '--squash',
      '--match-head-commit',
      HEAD_A,
      '--repo',
      'org/repo',
    ]);
    expect(
      calls.some((c) => c.args.includes('checks') || String(c.args[1]).includes('/check-runs')),
    ).toBe(false);
  });

  it('refuses under strict policy / untrusted sourceKind / no root without spending a gh call', async () => {
    for (const extra of [
      { policyYaml: NEVER_YAML },
      { sourceKind: 'gh-issue' as const },
      { repoRoot: null },
    ]) {
      const { promise, calls } = runArm({}, extra);
      const r = await promise;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.armed).toBeFalsy();
      expect(calls).toEqual([]);
    }
  });

  it('applies the same trust checks as merge mode: fork, author, base, task, head commit author', async () => {
    const cases: Array<[Record<string, Partial<ExecResult>>, RegExp]> = [
      [{ 'gh pr view 42': { stdout: prView({ isCrossRepository: true }) } }, /fork/],
      [{ 'gh pr view 42': { stdout: prView({ author: { login: 'mallory' } }) } }, /"mallory"/],
      [{ 'gh pr view 42': { stdout: prView({ baseRefName: 'dev' }) } }, /base branch is "dev"/],
      [
        { 'gh pr view 42': { stdout: prView({ files: [] }) }, ...treeHandlers({}) },
        /no backlog task file/,
      ],
      [
        { [`commits/${HEAD_A} --jq {author`]: { stdout: '{"author":"mallory","committer":null}' } },
        /head commit author "mallory"/,
      ],
    ];
    for (const [patch, re] of cases) {
      const { promise, calls } = runArm({ ...ARM_OK, ...patch });
      const r = await promise;
      expect(r.eligibility.reason).toMatch(re);
      expect(r.armed).toBeFalsy();
      expect(armCalls(calls)).toEqual([]);
    }
    const noList = await runArm(ARM_OK, { policyYaml: 'governance:\n  allowMerge: onGreenClean\n' })
      .promise;
    expect(noList.eligibility.reason).toMatch(/empty list trusts nobody/);
  });

  it('head moved between the trust checks and the arm: refuses, never arms', async () => {
    let views = 0;
    const calls: RecordedCall[] = [];
    const delegate = makeFakeRunner(ARM_OK).runner;
    const runner: Runner = async (command, args, o) => {
      calls.push({ command, args });
      if (args[1] === 'view') {
        views += 1;
        return {
          stdout: prView({ headRefOid: views === 1 ? HEAD_A : HEAD_B }),
          stderr: '',
          code: 0,
        };
      }
      return delegate(command, args, o);
    };
    const r = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
      mode: 'arm',
    });
    expect(r.armed).toBeFalsy();
    expect(r.eligibility.reason).toMatch(/head moved from a{40} to b{40}/);
    expect(armCalls(calls)).toEqual([]);
  });

  it('refuses when the pre-arm re-read fails, or GitHub refuses the arm', async () => {
    let views = 0;
    const delegate = makeFakeRunner(ARM_OK).runner;
    const runner: Runner = async (c, a, o) => {
      if (a[1] === 'view') {
        views += 1;
        return views === 1
          ? { stdout: prView(), stderr: '', code: 0 }
          : { stdout: '', stderr: 'x', code: 1 };
      }
      return delegate(c, a, o);
    };
    const failedReread = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
      mode: 'arm',
    });
    expect(failedReread.eligibility.reason).toMatch(
      /could not re-read the PR immediately before arming/,
    );
    const refused = await runArm({
      ...ARM_OK,
      'gh pr merge 42': { code: 1, stderr: 'auto merge is not allowed for this repository' },
    }).promise;
    expect(refused.armed).toBeFalsy();
    expect(refused.eligibility.eligible).toBe(false);
    expect(refused.eligibility.reason).toMatch(
      /arming auto-merge was refused by GitHub.*not allowed/,
    );
  });

  it('dry-run evaluates the trust checks but never re-reads or arms', async () => {
    const { promise, calls } = runArm(ARM_OK, { dryRun: true });
    const r = await promise;
    expect(r).toMatchObject({ dryRun: true, merged: false });
    expect(r.armed).toBeFalsy();
    expect(r.eligibility.eligible).toBe(true);
    expect(calls.filter((c) => c.args[1] === 'view')).toHaveLength(1);
    expect(armCalls(calls)).toEqual([]);
  });
});

describe('resolveMainSha', () => {
  it('returns the commit SHA of the main BRANCH ref', async () => {
    const { runner, calls } = makeFakeRunner(MAIN_REF);
    expect(await resolveMainSha('org/repo', runner)).toBe(MAIN_SHA);
    expect(calls[0].args[1]).toBe('repos/org/repo/git/ref/heads/main');
  });

  it('fails closed on errors, non-commit objects, bad SHAs and garbage', async () => {
    for (const handler of [
      { code: 1, stderr: 'HTTP 404' },
      { stdout: JSON.stringify({ type: 'tag', sha: MAIN_SHA }) },
      { stdout: JSON.stringify({ type: 'commit', sha: 'main' }) },
      { stdout: JSON.stringify({ type: 'commit' }) },
      { stdout: 'not json' },
    ]) {
      const { runner } = makeFakeRunner({ 'git/ref/heads/main': handler });
      expect(await resolveMainSha('org/repo', runner)).toBeNull();
    }
  });
});

describe('one consistent main commit for every read', () => {
  const TAG_TRAP = {
    // What the short ref `main` would return if a tag named main shadowed the branch.
    'contents/.ai-sdlc/agent-role.yaml?ref=main': { stdout: NEVER_YAML },
    'contents/backlog/config.yml?ref=main': { stdout: 'task_prefix: EVIL\n' },
    'git/trees/main --jq': { stdout: '{"truncated":false,"tree":[]}' },
  };

  function flow(handlers: Record<string, Partial<ExecResult>>, extra = {}) {
    const fake = makeFakeRunner(handlers);
    const promise = runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner: fake.runner,
      ...extra,
    });
    return { promise, calls: fake.calls };
  }

  const ALL: Record<string, Partial<ExecResult>> = {
    ...TAG_TRAP,
    'gh pr view 42': { stdout: prView({ files: [] }) },
    ...MAIN_REF,
    ...CLEAN_FILES,
    'gh pr checks 42 --required': { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]) },
    ...COMMIT_OPERATOR,
    ...shaChecks(HEAD_A, [['ci', 'completed', 'success']]),
    [`contents/.ai-sdlc/agent-role.yaml?ref=${MAIN_SHA}`]: { stdout: GREEN_YAML },
    [`contents/backlog/config.yml?ref=${MAIN_SHA}`]: { stdout: 'task_prefix: AISDLC\n' },
    ...treeHandlers({ completed: ['aisdlc-9 - do the thing.md'] }),
    'gh pr merge 42': {},
  };

  it('a tag named main cannot change the answer: policy, config and task tree come from the branch SHA', async () => {
    const { promise, calls } = flow(ALL);
    const r = await promise;
    expect(r.merged).toBe(true);
    const joined = calls.map((c) => c.args.join(' '));
    expect(joined.filter((l) => l.includes('git/ref/heads/main'))).toHaveLength(1);
    expect(joined.some((l) => l.includes('ref=main') || l.includes('git/trees/main '))).toBe(false);
    for (const l of joined.filter((x) => x.includes('contents/') || x.includes('git/trees/'))) {
      expect(l).toMatch(new RegExp(`${MAIN_SHA}|${SHA_BACKLOG}|${SHA_TASKS}|${SHA_COMPLETED}`));
    }
  });

  it('refuses when main cannot be resolved to a commit (policy, prefix or task tree)', async () => {
    const noRef = { ...ALL, 'git/ref/heads/main': { code: 1, stderr: 'HTTP 404' } };
    const policy = await flow(noRef).promise;
    expect(policy.eligibility.reason).toMatch(
      /could not read \.ai-sdlc\/agent-role\.yaml from main/,
    );
    const prefix = await flow(noRef, { policyYaml: GREEN_YAML }).promise;
    expect(prefix.eligibility.reason).toMatch(/could not resolve the main branch/);
    const tree = await flow(noRef, { policyYaml: GREEN_YAML, taskPrefix: 'AISDLC' }).promise;
    expect(tree.eligibility.reason).toMatch(/could not resolve the main branch/);
    expect(tree.merged).toBe(false);
  });
});

describe('governance-sensitive changes require a human merge (merge and arm)', () => {
  it.each([
    '.ai-sdlc/agent-role.yaml',
    '.ai-sdlc/attestations/x.json',
    'ai-sdlc-plugin/hooks/enforce-blocked-actions.js',
    'ai-sdlc-plugin/hooks/lib/governance-resolver.js',
    'pipeline-cli/src/governance/merge-if-eligible.ts',
    'pipeline-cli/src/cli/merge-if-eligible.ts',
    'pipeline-cli/src/cli/merge-if-eligible.test.ts',
    'pipeline-cli/bin/cli-merge-if-eligible.mjs',
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    'spec/schemas/agent-role.schema.json',
    'opencode.json',
    'opencode.jsonc',
    '.opencode/plugins/x.js',
    'CLAUDE.md',
    'packages/app/CLAUDE.md',
    '.AI-SDLC/agent-role.yaml',
    'AI-SDLC-Plugin/Hooks/x.js',
    'claude.MD',
    './.ai-sdlc/x',
    '/.github/workflows/x.yml',
    '.github//workflows/x.yml',
    '.ai-sdlc\\agent-role.yaml',
  ])('path class %s is sensitive', (path) => {
    expect(isGovernanceSensitivePath(path)).toBe(true);
  });

  it.each([
    'pipeline-cli/src/foo.ts',
    'docs/api-reference/governance.md',
    'backlog/completed/aisdlc-9 - x.md',
    'sub/.github/x.yml',
    'ai-sdlc-plugin/commands/execute.md',
    'pipeline-cli/src/governance-notes.md',
    'my-opencode.json.bak',
    'spec/schemas/other.schema.json',
  ])('ordinary path %s is not sensitive', (path) => {
    expect(isGovernanceSensitivePath(path)).toBe(false);
  });

  it('checks both the new and the previous name (rename into and out of sensitive paths)', () => {
    expect(
      governanceSensitiveChanges([
        { path: '.ai-sdlc/x.yaml', previousPath: 'docs/x.yaml', status: 'renamed' },
      ]),
    ).toEqual(['.ai-sdlc/x.yaml']);
    expect(
      governanceSensitiveChanges([
        { path: 'docs/x.yaml', previousPath: '.ai-sdlc/x.yaml', status: 'renamed' },
      ]),
    ).toEqual(['.ai-sdlc/x.yaml']);
    expect(governanceSensitiveChanges([{ path: 'docs/a.md', status: 'added' }])).toEqual([]);
    expect(
      governanceSensitiveChanges([
        { path: 'CLAUDE.md', status: 'modified' },
        { path: 'CLAUDE.md', status: 'modified' },
      ]),
    ).toEqual(['CLAUDE.md']);
  });

  async function gate(files: Record<string, Partial<ExecResult>>, mode: 'merge' | 'arm') {
    const fake = makeFakeRunner({
      'gh pr view 42': { stdout: prView() },
      ...MAIN_REF,
      ...files,
      'gh pr checks 42 --required': { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]) },
      ...COMMIT_OPERATOR,
      ...shaChecks(HEAD_A, [['ci', 'completed', 'success']]),
      'gh pr merge 42': {},
    });
    const r = await runMergeIfEligible({
      prNumber: 42,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/unused',
      runner: fake.runner,
      policyYaml: GREEN_YAML,
      taskPrefix: 'AISDLC',
      mode,
    });
    return { r, calls: fake.calls };
  }

  for (const mode of ['merge', 'arm'] as const) {
    it(`${mode}: refuses a PR touching a governance path, with no merge/arm call`, async () => {
      const { r, calls } = await gate(
        changedFiles([
          ['backlog/completed/aisdlc-9 - do the thing.md'],
          ['.ai-sdlc/agent-role.yaml', 'modified'],
        ]),
        mode,
      );
      expect(r.eligibility.reason).toMatch(
        /governance-sensitive paths \(\.ai-sdlc\/agent-role\.yaml\).*human merge/,
      );
      expect(r.merged).toBe(false);
      expect(r.armed).toBeFalsy();
      expect(calls.some((c) => c.args.includes('merge'))).toBe(false);
    });

    it(`${mode}: refuses a rename out of a governance path`, async () => {
      const { r } = await gate(
        changedFiles([['docs/moved.yaml', 'renamed', '.ai-sdlc/old.yaml']]),
        mode,
      );
      expect(r.eligibility.reason).toMatch(/\.ai-sdlc\/old\.yaml/);
    });

    it(`${mode}: refuses when the file list cannot be read or hits GitHub's cap`, async () => {
      const failed = await gate({ 'pulls/42/files': { code: 1, stderr: 'HTTP 500' } }, mode);
      expect(failed.r.eligibility.reason).toMatch(/could not list every file/);
      const capped = await gate(
        changedFiles(Array.from({ length: 3000 }, (_, i): Changed => [`docs/f${i}.md`])),
        mode,
      );
      expect(capped.r.eligibility.reason).toMatch(/could not list every file/);
      const garbage = await gate({ 'pulls/42/files': { stdout: 'not json' } }, mode);
      expect(garbage.r.eligibility.reason).toMatch(/could not list every file/);
      const noName = await gate({ 'pulls/42/files': { stdout: '{"status":"added"}' } }, mode);
      expect(noName.r.eligibility.reason).toMatch(/could not list every file/);
    });

    it(`${mode}: proceeds just under the cap with only ordinary paths`, async () => {
      const { r } = await gate(
        changedFiles([
          ['backlog/completed/aisdlc-9 - do the thing.md'],
          ...Array.from({ length: 2998 }, (_, i): Changed => [`docs/f${i}.md`]),
        ]),
        mode,
      );
      expect(r.eligibility.eligible).toBe(true);
    });
  }
});

describe('resolveRepoSlug rejects dot owners and repos', () => {
  it('refuses ".", ".." in either position', async () => {
    for (const slug of ['./repo', '../repo', 'org/.', 'org/..', '../..']) {
      const { runner } = makeFakeRunner({ 'gh repo view': { stdout: `${slug}\n` } });
      expect(await resolveRepoSlug(runner)).toBeNull();
    }
    const ok = makeFakeRunner({ 'gh repo view': { stdout: 'org/.github\n' } });
    expect(await resolveRepoSlug(ok.runner)).toBe('org/.github');
  });
});
