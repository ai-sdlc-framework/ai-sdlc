/**
 * Hermetic tests for `cli-pr-unstick` (AISDLC-139).
 *
 * The strategy: never invoke the real `gh` / `git` binaries. Every test
 * builds a `FakeRunner` that intercepts the (command, args) tuples the
 * module would normally pass to `child_process.execFile`, asserts on what
 * was called, and returns canned stdout/stderr/code triples that drive
 * the SUT's branches.
 *
 * Each Stage A check has at least:
 *   - one positive case (signal present → match)
 *   - one negative case (signal absent → no match)
 *   - dry-run vs apply assertions
 *
 * Detection helpers are tested directly with hand-built `PrInfo` objects;
 * the orchestration helpers (`runForOnePr`, `runForAllPrs`) and the yargs
 * router are exercised through the FakeRunner so we get end-to-end coverage
 * of the JSON parsing + sequencing + error handling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPrUnstickCli,
  CI_ATTESTOR_SUBJECT_PREFIX,
  detectAll,
  detectBacklogDrift,
  detectBehindMain,
  detectChoreStatusForwarding,
  detectDocsOnlyMissingPostReview,
  detectStaleAttestation,
  fetchPrInfo,
  listOpenPrs,
  type PrInfo,
  renderJsonResult,
  renderStageBPrompt,
  renderTextResult,
  resolveAll,
  resolveRepoSlug,
  runForAllPrs,
  runForOnePr,
} from './pr-unstick.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

// ── FakeRunner ────────────────────────────────────────────────────────

interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
}

interface FakeRunnerHandle {
  runner: Runner;
  calls: RecordedCall[];
  /** Register a stub for a (command, argsMatcher) tuple. First match wins. */
  on: (
    command: string,
    matcher: (args: string[]) => boolean,
    response: Partial<ExecResult>,
  ) => void;
}

function makeFakeRunner(): FakeRunnerHandle {
  const calls: RecordedCall[] = [];
  const stubs: Array<{
    command: string;
    matcher: (args: string[]) => boolean;
    response: Partial<ExecResult>;
  }> = [];

  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts?.cwd });
    for (const s of stubs) {
      if (s.command === command && s.matcher(args)) {
        const r: ExecResult = { stdout: '', stderr: '', code: 0, ...s.response };
        if (r.code !== 0 && !opts?.allowFailure) {
          const e = new Error(`fake ${command} failed: ${r.stderr || r.stdout}`);
          (e as Error & { result?: ExecResult }).result = r;
          throw e;
        }
        return r;
      }
    }
    // No stub → empty success. Lets us avoid registering every call when
    // a test only cares about a subset.
    return { stdout: '', stderr: '', code: 0 };
  };

  return {
    runner,
    calls,
    on: (command, matcher, response) => stubs.push({ command, matcher, response }),
  };
}

// ── PrInfo factories ──────────────────────────────────────────────────

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 123,
    title: 'feat: do the thing',
    baseRefName: 'main',
    headRefName: 'feature/x',
    headRefOid: 'deadbeefcafebabedeadbeefcafebabedeadbeef',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    files: ['src/foo.ts'],
    headSubject: 'feat: do the thing',
    parentOid: '0000aaa',
    statusesAtHead: new Map(),
    statusesAtParent: new Map(),
    checkRunsAtHead: new Map(),
    approvingReviewCount: 0,
    ...overrides,
  };
}

// ── Detection: chore-status-forwarding ────────────────────────────────

describe('detectChoreStatusForwarding', () => {
  it('matches when HEAD is a CI-attestor commit and required statuses missing at HEAD but present at parent', () => {
    const pr = makePr({
      headSubject: `${CI_ATTESTOR_SUBJECT_PREFIX} (skip ci marker)`,
      statusesAtHead: new Map(),
      statusesAtParent: new Map([
        ['CI OK', 'success'],
        ['Post Review Results', 'success'],
        ['codecov/patch', 'success'],
      ]),
    });
    const m = detectChoreStatusForwarding(pr);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('chore-status-forwarding');
    expect(m!.actions).toHaveLength(3);
    expect(m!.autoFixable).toBe(true);
  });

  it('does not match when HEAD subject is not a CI-attestor commit', () => {
    const pr = makePr({
      headSubject: 'feat: ordinary work',
      statusesAtHead: new Map(),
      statusesAtParent: new Map([['CI OK', 'success']]),
    });
    expect(detectChoreStatusForwarding(pr)).toBeNull();
  });

  it('does not match when statuses are already present at HEAD', () => {
    const pr = makePr({
      headSubject: `${CI_ATTESTOR_SUBJECT_PREFIX} (skip ci marker)`,
      statusesAtHead: new Map([
        ['CI OK', 'success'],
        ['Post Review Results', 'success'],
        ['codecov/patch', 'success'],
      ]),
      statusesAtParent: new Map([['CI OK', 'success']]),
    });
    expect(detectChoreStatusForwarding(pr)).toBeNull();
  });

  it('does not match when parent does not have the success statuses to forward', () => {
    const pr = makePr({
      headSubject: `${CI_ATTESTOR_SUBJECT_PREFIX} (skip ci marker)`,
      statusesAtHead: new Map(),
      statusesAtParent: new Map([['CI OK', 'failure']]),
    });
    expect(detectChoreStatusForwarding(pr)).toBeNull();
  });
});

// ── Detection: rebase-when-behind ─────────────────────────────────────

describe('detectBehindMain', () => {
  it('matches when mergeStateStatus is BEHIND', () => {
    const m = detectBehindMain(makePr({ mergeStateStatus: 'BEHIND' }));
    expect(m?.id).toBe('rebase-when-behind');
    expect(m?.autoFixable).toBe(true);
  });

  it('does not match when mergeStateStatus is CLEAN', () => {
    expect(detectBehindMain(makePr({ mergeStateStatus: 'CLEAN' }))).toBeNull();
  });
});

// ── Detection: docs-only-fallback ─────────────────────────────────────

describe('detectDocsOnlyMissingPostReview', () => {
  it('matches when every file is docs-only and Post Review Results is missing', () => {
    const pr = makePr({
      files: ['docs/x.md', 'spec/rfcs/RFC-0001.md', 'README.md', 'backlog/tasks/foo.md'],
      statusesAtHead: new Map(),
    });
    const m = detectDocsOnlyMissingPostReview(pr);
    expect(m?.id).toBe('docs-only-fallback');
  });

  it('does not match when ANY file is non-docs', () => {
    const pr = makePr({
      files: ['docs/x.md', 'src/code.ts'],
      statusesAtHead: new Map(),
    });
    expect(detectDocsOnlyMissingPostReview(pr)).toBeNull();
  });

  it('does not match when Post Review Results is already success', () => {
    const pr = makePr({
      files: ['docs/x.md'],
      statusesAtHead: new Map([['Post Review Results', 'success']]),
    });
    expect(detectDocsOnlyMissingPostReview(pr)).toBeNull();
  });

  it('does not double-fire on AISDLC-87 chore commits (those go to #1)', () => {
    const pr = makePr({
      files: ['docs/x.md'],
      headSubject: `${CI_ATTESTOR_SUBJECT_PREFIX} (skip ci marker)`,
      statusesAtHead: new Map(),
    });
    expect(detectDocsOnlyMissingPostReview(pr)).toBeNull();
  });

  it('does not match when files list is empty', () => {
    const pr = makePr({ files: [] });
    expect(detectDocsOnlyMissingPostReview(pr)).toBeNull();
  });
});

// ── Detection: stale-attestation ──────────────────────────────────────

describe('detectStaleAttestation', () => {
  it('matches when attestation check is failure AND ≥3 approvals', () => {
    const pr = makePr({
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'failure']]),
      approvingReviewCount: 3,
    });
    const m = detectStaleAttestation(pr);
    expect(m?.id).toBe('stale-attestation');
  });

  it('matches via the statusesAtHead path too (some PRs report attestation as a status, not a check)', () => {
    const pr = makePr({
      statusesAtHead: new Map([['ai-sdlc/attestation', 'failure']]),
      approvingReviewCount: 3,
    });
    expect(detectStaleAttestation(pr)?.id).toBe('stale-attestation');
  });

  it('does not match when fewer than 3 approvals', () => {
    const pr = makePr({
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'failure']]),
      approvingReviewCount: 1,
    });
    expect(detectStaleAttestation(pr)).toBeNull();
  });

  it('does not match when attestation is success', () => {
    const pr = makePr({
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'success']]),
      approvingReviewCount: 5,
    });
    expect(detectStaleAttestation(pr)).toBeNull();
  });

  it('does not match when attestation context is absent entirely', () => {
    expect(detectStaleAttestation(makePr({ approvingReviewCount: 5 }))).toBeNull();
  });
});

// ── Detection: backlog-drift-report ───────────────────────────────────

describe('detectBacklogDrift', () => {
  it('matches when Backlog Drift check is failure', () => {
    const pr = makePr({ checkRunsAtHead: new Map([['Backlog Drift', 'failure']]) });
    const m = detectBacklogDrift(pr);
    expect(m?.id).toBe('backlog-drift-report');
    expect(m?.autoFixable).toBe(false);
  });

  it('does not match when Backlog Drift is success', () => {
    expect(
      detectBacklogDrift(makePr({ checkRunsAtHead: new Map([['Backlog Drift', 'success']]) })),
    ).toBeNull();
  });
});

// ── detectAll: no-op-when-clean ──────────────────────────────────────

describe('detectAll', () => {
  it('returns an empty array on a clean PR', () => {
    const pr = makePr({
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      statusesAtHead: new Map([
        ['CI OK', 'success'],
        ['Post Review Results', 'success'],
        ['codecov/patch', 'success'],
      ]),
    });
    expect(detectAll({ pr })).toEqual([]);
  });

  it('returns multiple matches when multiple symptoms are present', () => {
    const pr = makePr({
      mergeStateStatus: 'BEHIND',
      checkRunsAtHead: new Map([['Backlog Drift', 'failure']]),
    });
    const matches = detectAll({ pr });
    const ids = matches.map((m) => m.id);
    expect(ids).toContain('rebase-when-behind');
    expect(ids).toContain('backlog-drift-report');
  });
});

// ── Resolution / dry-run ─────────────────────────────────────────────

describe('resolveAll', () => {
  it('respects --dry-run by tagging every outcome dry-run with no shell calls', async () => {
    const fake = makeFakeRunner();
    const pr = makePr({ mergeStateStatus: 'BEHIND' });
    const matches = detectAll({ pr });
    const outcomes = await resolveAll({
      pr,
      matches,
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: true,
      runner: fake.runner,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('dry-run');
    expect(fake.calls).toHaveLength(0);
  });

  it('applies the rebase fix for BEHIND', async () => {
    const fake = makeFakeRunner();
    const pr = makePr({ number: 42, mergeStateStatus: 'BEHIND' });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('applied');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('gh');
    expect(fake.calls[0].args).toEqual(['pr', 'update-branch', '--rebase', '42']);
  });

  it('forwards each missing required status for chore-status-forwarding', async () => {
    const fake = makeFakeRunner();
    const pr = makePr({
      headSubject: `${CI_ATTESTOR_SUBJECT_PREFIX} (skip ci marker)`,
      statusesAtHead: new Map(),
      statusesAtParent: new Map([
        ['CI OK', 'success'],
        ['Post Review Results', 'success'],
        ['codecov/patch', 'success'],
      ]),
    });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('applied');
    // 3 forwarded statuses → 3 gh api calls.
    expect(fake.calls).toHaveLength(3);
    for (const c of fake.calls) {
      expect(c.command).toBe('gh');
      expect(c.args[0]).toBe('api');
      expect(c.args).toContain('-X');
      expect(c.args).toContain('POST');
      expect(c.args).toContain('state=success');
    }
    const contexts = fake.calls.map((c) => c.args.find((a) => a.startsWith('context=')));
    expect(contexts.sort()).toEqual([
      'context=CI OK',
      'context=Post Review Results',
      'context=codecov/patch',
    ]);
  });

  it('forwards Post Review Results for docs-only-fallback', async () => {
    const fake = makeFakeRunner();
    const pr = makePr({
      files: ['docs/x.md'],
      statusesAtHead: new Map(),
    });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('applied');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args).toContain('context=Post Review Results');
  });

  it('refuses no-op-push from main branch (safety guard)', async () => {
    const fake = makeFakeRunner();
    fake.on('git', (a) => a[0] === 'rev-parse' && a.includes('--abbrev-ref'), {
      stdout: 'main\n',
    });
    const pr = makePr({
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'failure']]),
      approvingReviewCount: 3,
    });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toContain('refusing to no-op-push');
  });

  it('issues an empty commit + force-with-lease push for stale-attestation on a feature branch', async () => {
    const fake = makeFakeRunner();
    fake.on('git', (a) => a[0] === 'rev-parse' && a.includes('--abbrev-ref'), {
      stdout: 'feature/x\n',
    });
    const pr = makePr({
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'failure']]),
      approvingReviewCount: 3,
    });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('applied');
    const cmds = fake.calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(cmds).toEqual([
      'git rev-parse --abbrev-ref HEAD',
      'git commit --allow-empty -m chore: trigger CI re-run for stale attestation',
      'git push --force-with-lease',
    ]);
  });

  it('marks backlog-drift-report as report (never auto-fixes)', async () => {
    const fake = makeFakeRunner();
    const pr = makePr({ checkRunsAtHead: new Map([['Backlog Drift', 'failure']]) });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('report');
    expect(fake.calls).toHaveLength(0);
  });

  it('captures runner errors into outcome.error without throwing', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'update-branch', {
      code: 1,
      stderr: 'merge conflict',
    });
    const pr = makePr({ mergeStateStatus: 'BEHIND' });
    const outcomes = await resolveAll({
      pr,
      matches: detectAll({ pr }),
      repoSlug: 'org/repo',
      cwd: '/tmp',
      dryRun: false,
      runner: fake.runner,
    });
    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toContain('merge conflict');
  });
});

// ── fetchPrInfo / GitHub plumbing ─────────────────────────────────────

describe('fetchPrInfo', () => {
  it('parses the gh pr view + commit + status + check-runs payloads into PrInfo', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'view', {
      stdout: JSON.stringify({
        number: 176,
        title: 'chore(ci): bootstrap',
        baseRefName: 'main',
        headRefName: 'ai-sdlc/foo',
        headRefOid: '13744ed8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergeStateStatus: 'BLOCKED',
        mergeable: 'MERGEABLE',
        files: [{ path: 'docs/foo.md' }, { path: 'README.md' }],
        reviews: [
          { author: { login: 'a' }, state: 'APPROVED' },
          { author: { login: 'b' }, state: 'APPROVED' },
          { author: { login: 'c' }, state: 'APPROVED' },
          { author: { login: 'a' }, state: 'COMMENTED' }, // most-recent for `a` keeps APPROVED if order asc
        ],
      }),
    });
    fake.on(
      'gh',
      (a) =>
        a[0] === 'api' &&
        a[1].startsWith('repos/') &&
        a[1].endsWith('/commits/13744ed8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      {
        stdout: JSON.stringify({
          message: 'chore(ci): sign review attestation (skip ci marker)\n\nbody',
          parents: ['parentSha000'],
        }),
      },
    );
    fake.on(
      'gh',
      (a) => a[0] === 'api' && a[1].endsWith('/13744ed8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status'),
      {
        stdout: JSON.stringify({
          statuses: [
            { context: 'CI OK', state: 'pending' },
            { context: 'codecov/patch', state: 'success' },
          ],
        }),
      },
    );
    fake.on('gh', (a) => a[0] === 'api' && a[1].endsWith('/parentSha000/status'), {
      stdout: JSON.stringify({
        statuses: [
          { context: 'CI OK', state: 'success' },
          { context: 'Post Review Results', state: 'success' },
        ],
      }),
    });
    fake.on(
      'gh',
      (a) => a[0] === 'api' && a[1].includes('/check-runs') && a[1].includes('13744ed8'),
      {
        stdout: JSON.stringify([
          { name: 'ai-sdlc/attestation', conclusion: 'failure' },
          { name: 'Backlog Drift', conclusion: 'success' },
        ]),
      },
    );

    const pr = await fetchPrInfo(176, 'org/repo', fake.runner, '/tmp');
    expect(pr.number).toBe(176);
    expect(pr.headSubject).toBe('chore(ci): sign review attestation (skip ci marker)');
    expect(pr.parentOid).toBe('parentSha000');
    expect(pr.statusesAtHead.get('codecov/patch')).toBe('success');
    expect(pr.statusesAtParent.get('CI OK')).toBe('success');
    expect(pr.checkRunsAtHead.get('ai-sdlc/attestation')).toBe('failure');
    expect(pr.files).toEqual(['docs/foo.md', 'README.md']);
    // 3 distinct authors all APPROVED (latest-state for `a` was COMMENTED so
    // they collapse out → only b, c approving = 2). Drives the doc that the
    // function is per-author-latest, not raw count.
    expect(pr.approvingReviewCount).toBe(2);
  });

  it('tolerates empty status / check-runs payloads (returns empty maps)', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'view', {
      stdout: JSON.stringify({
        number: 1,
        headRefOid: 'abc',
        files: [],
        reviews: [],
      }),
    });
    fake.on('gh', (a) => a[0] === 'api' && a[1].endsWith('/commits/abc'), {
      stdout: JSON.stringify({ message: 'feat: x', parents: [] }),
    });
    fake.on('gh', (a) => a[0] === 'api' && a[1].endsWith('/status'), {
      stdout: '',
      code: 1,
      stderr: 'not found',
    });
    fake.on('gh', (a) => a[0] === 'api' && a[1].includes('/check-runs'), {
      stdout: '',
      code: 1,
      stderr: 'not found',
    });

    const pr = await fetchPrInfo(1, 'org/repo', fake.runner, '/tmp');
    expect(pr.statusesAtHead.size).toBe(0);
    expect(pr.checkRunsAtHead.size).toBe(0);
    expect(pr.parentOid).toBe('');
  });
});

describe('resolveRepoSlug', () => {
  it('returns the trimmed slug from gh repo view', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'repo', { stdout: 'org/repo\n' });
    expect(await resolveRepoSlug(fake.runner)).toBe('org/repo');
  });
});

describe('listOpenPrs', () => {
  it('parses the JSON-array output', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'list', { stdout: '[1,2,3]\n' });
    expect(await listOpenPrs('org/repo', fake.runner)).toEqual([1, 2, 3]);
  });

  it('returns [] on malformed JSON', async () => {
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'list', { stdout: 'not json' });
    expect(await listOpenPrs('org/repo', fake.runner)).toEqual([]);
  });
});

// ── runForOnePr / runForAllPrs ───────────────────────────────────────

function stubViewPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 100,
    title: 't',
    baseRefName: 'main',
    headRefName: 'feat/x',
    headRefOid: 'shaaa',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    files: [],
    reviews: [],
    ...overrides,
  });
}

function stubAllRunner(views: Record<number, string>): FakeRunnerHandle {
  const stubs = makeFakeRunner();
  // Per-PR view matchers — capture the requested PR number by argv position.
  for (const [n, payload] of Object.entries(views)) {
    stubs.on('gh', (a) => a[0] === 'pr' && a[1] === 'view' && a[2] === String(n), {
      stdout: payload,
    });
  }
  stubs.on('gh', (a) => a[0] === 'api' && /\/commits\/[^/]+$/.test(a[1]), {
    stdout: JSON.stringify({ message: 'feat: x', parents: [] }),
  });
  stubs.on('gh', (a) => a[0] === 'api' && a[1].endsWith('/status'), {
    stdout: JSON.stringify({ statuses: [] }),
  });
  stubs.on('gh', (a) => a[0] === 'api' && a[1].includes('/check-runs'), {
    stdout: JSON.stringify([]),
  });
  return stubs;
}

describe('runForOnePr', () => {
  it('returns matches+outcomes for a clean PR (empty lists)', async () => {
    const fake = stubAllRunner({ 100: stubViewPayload() });
    const r = await runForOnePr({
      prNumber: 100,
      repoSlug: 'org/repo',
      runner: fake.runner,
      cwd: '/tmp',
      dryRun: true,
    });
    expect(r.matches).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(r.pr.number).toBe(100);
  });
});

describe('runForAllPrs', () => {
  it('iterates every supplied PR and continues past per-PR errors', async () => {
    const fake = makeFakeRunner();
    // PR 1 succeeds (BEHIND) → match + dry-run outcome.
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'view' && a[2] === '1', {
      stdout: stubViewPayload({ number: 1, mergeStateStatus: 'BEHIND' }),
    });
    // PR 2 throws on the gh pr view call.
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'view' && a[2] === '2', {
      stdout: '',
      code: 1,
      stderr: 'gh: Not Found',
    });
    // PR 3 succeeds (clean, no matches).
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'view' && a[2] === '3', {
      stdout: stubViewPayload({ number: 3 }),
    });
    fake.on('gh', (a) => a[0] === 'api' && /\/commits\/[^/]+$/.test(a[1]), {
      stdout: JSON.stringify({ message: 'm', parents: [] }),
    });
    fake.on('gh', (a) => a[0] === 'api' && a[1].endsWith('/status'), {
      stdout: JSON.stringify({ statuses: [] }),
    });
    fake.on('gh', (a) => a[0] === 'api' && a[1].includes('/check-runs'), {
      stdout: JSON.stringify([]),
    });

    const results = await runForAllPrs({
      repoSlug: 'org/repo',
      runner: fake.runner,
      cwd: '/tmp',
      dryRun: true,
      prNumbers: [1, 2, 3],
    });
    expect(results).toHaveLength(3);
    expect(results[0].matches.map((m) => m.id)).toContain('rebase-when-behind');
    expect(results[1].error).toContain('gh: Not Found');
    expect(results[2].matches).toEqual([]);
  });

  it('fetches the PR list when prNumbers is omitted', async () => {
    const fake = stubAllRunner({ 7: stubViewPayload({ number: 7 }) });
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'list', { stdout: '[7]' });
    const results = await runForAllPrs({
      repoSlug: 'org/repo',
      runner: fake.runner,
      cwd: '/tmp',
      dryRun: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].pr.number).toBe(7);
  });
});

// ── Stage B prompt rendering ──────────────────────────────────────────

describe('renderStageBPrompt', () => {
  it('includes every key signal and the diagnosis question', () => {
    const pr = makePr({
      number: 166,
      title: 'feat: do something',
      headRefOid: 'aaaaaaa',
      statusesAtHead: new Map([['CI OK', 'pending']]),
      checkRunsAtHead: new Map([['ai-sdlc/attestation', 'success']]),
      files: Array.from({ length: 35 }, (_, i) => `f${i}.ts`),
    });
    const md = renderStageBPrompt(pr);
    expect(md).toContain('PR #166');
    expect(md).toContain('mergeStateStatus');
    expect(md).toContain('CI OK');
    expect(md).toContain('ai-sdlc/attestation');
    expect(md).toContain('Why is this stuck?');
    // Long file list truncates after 30: 35 - 30 = 5 hidden.
    expect(md).toContain('5 more');
  });

  it('handles an empty PR cleanly', () => {
    const md = renderStageBPrompt(makePr({ files: [], checkRunsAtHead: new Map() }));
    expect(md).toContain('_(none)_');
  });
});

// ── Text + JSON renderers ────────────────────────────────────────────

describe('renderTextResult', () => {
  it('includes match info when matches present', () => {
    const pr = makePr({ number: 1, mergeStateStatus: 'BEHIND' });
    const result = {
      pr,
      matches: detectAll({ pr }),
      outcomes: [
        {
          ...detectBehindMain(pr)!,
          status: 'dry-run' as const,
        },
      ],
    };
    const out = renderTextResult(result);
    expect(out).toContain('PR #1');
    expect(out).toContain('rebase-when-behind');
    expect(out).toContain('DRY-RUN');
  });

  it('renders no-match cleanly', () => {
    const out = renderTextResult({ pr: makePr({ number: 2 }), matches: [], outcomes: [] });
    expect(out).toContain('no Stage A matches');
  });

  it('renders the error path', () => {
    const out = renderTextResult({
      pr: makePr({ number: 3 }),
      matches: [],
      outcomes: [],
      error: 'boom',
    });
    expect(out).toContain('ERROR: boom');
  });
});

describe('renderJsonResult', () => {
  it('emits valid JSON with serialised maps', () => {
    const pr = makePr({
      statusesAtHead: new Map([['CI OK', 'success']]),
    });
    const out = renderJsonResult([{ pr, matches: [], outcomes: [] }]);
    const parsed = JSON.parse(out) as {
      results: Array<{ pr: { statusesAtHead: Record<string, string> } }>;
    };
    expect(parsed.results[0].pr.statusesAtHead['CI OK']).toBe('success');
  });
});

// ── yargs router (end-to-end) ────────────────────────────────────────

describe('cli-pr-unstick yargs router', () => {
  let savedArgv: string[];
  let savedExit: typeof process.exit;
  let savedStdout: typeof process.stdout.write;
  let savedStderr: typeof process.stderr.write;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    savedArgv = process.argv;
    savedExit = process.exit;
    savedStdout = process.stdout.write.bind(process.stdout);
    savedStderr = process.stderr.write.bind(process.stderr);
    stdoutChunks = [];
    stderrChunks = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exit = savedExit;
    process.stdout.write = savedStdout;
    process.stderr.write = savedStderr;
  });

  it('errors when neither pr-number nor --all is given', async () => {
    process.argv = ['node', 'cli-pr-unstick'];
    const fake = makeFakeRunner();
    fake.on('gh', (a) => a[0] === 'repo', { stdout: 'org/repo\n' });
    await expect(buildPrUnstickCli({ runner: fake.runner }).parseAsync()).rejects.toThrow(
      /process\.exit/,
    );
    expect(stderrChunks.join('')).toContain('pass a PR number');
  });

  it('runs single-PR mode end-to-end with --dry-run + --format json', async () => {
    process.argv = [
      'node',
      'cli-pr-unstick',
      '42',
      '--dry-run',
      '--format',
      'json',
      '--repo',
      'org/repo',
      '--cwd',
      '/tmp',
    ];
    const fake = stubAllRunner({ 42: stubViewPayload({ number: 42, mergeStateStatus: 'BEHIND' }) });
    await buildPrUnstickCli({ runner: fake.runner }).parseAsync();
    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out) as {
      results: Array<{ matches: Array<{ id: string }> }>;
    };
    expect(parsed.results[0].matches[0].id).toBe('rebase-when-behind');
  });

  it('--all sweeps every PR and exits 0 when at least one resolves', async () => {
    process.argv = [
      'node',
      'cli-pr-unstick',
      '--all',
      '--dry-run',
      '--repo',
      'org/repo',
      '--cwd',
      '/tmp',
    ];
    const fake = stubAllRunner({ 1: stubViewPayload({ number: 1 }) });
    fake.on('gh', (a) => a[0] === 'pr' && a[1] === 'list', { stdout: '[1]' });
    await buildPrUnstickCli({ runner: fake.runner }).parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toContain('PR #1');
  });

  it('--stage-b appends a Stage B prompt for PRs with no matches', async () => {
    process.argv = [
      'node',
      'cli-pr-unstick',
      '99',
      '--dry-run',
      '--stage-b',
      '--repo',
      'org/repo',
      '--cwd',
      '/tmp',
    ];
    const fake = stubAllRunner({ 99: stubViewPayload({ number: 99 }) });
    await buildPrUnstickCli({ runner: fake.runner }).parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toContain('Stage B diagnosis prompt');
    expect(out).toContain('Why is this stuck?');
  });
});
