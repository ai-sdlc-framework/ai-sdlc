/**
 * Hermetic tests for the `release` source kind (AISDLC-702). Every GitHub call
 * goes through an injected fake Runner; nothing touches the network.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAuthorRefusal,
  defaultAuditWriter,
  isReleaseArtifactPath,
  nonReleaseFiles,
  RELEASE_BOT_EMAIL,
  RELEASE_BRANCH,
  resolveCallerRole,
  resolveReleaseGovernance,
  runReleaseMerge,
  type ReleaseAuditRecord,
  type RunReleaseMergeOptions,
} from './release-merge.js';
import {
  evaluateMergeEligibility,
  runMergeIfEligible,
  STRICT_DEFAULTS,
} from './merge-if-eligible.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

const HEAD = 'c'.repeat(40);
const MAIN_SHA = 'd'.repeat(40);
const YAML = 'spec:\n  governance:\n    allowMerge: never\n    releaseAuthors: [deefactorial]\n';

interface Fixture {
  pr?: Record<string, unknown>;
  prAfter?: Record<string, unknown>;
  commits?: Array<{ sha: string; login: string | null; email: string }>;
  files?: string[];
  required?: Array<{ name: string; state: string }>;
  shaChecks?: Array<{ name: string; status: string; conclusion: string | null }>;
  mergeFails?: boolean;
}

function pr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headRefOid: HEAD,
    headRefName: RELEASE_BRANCH,
    baseRefName: 'main',
    isCrossRepository: false,
    author: { login: 'deefactorial' },
    title: 'chore: release main',
    mergeStateStatus: 'CLEAN',
    files: [],
    ...over,
  };
}

function makeRunner(f: Fixture = {}) {
  const calls: string[] = [];
  let views = 0;
  const runner: Runner = async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
    if (key.includes('pr view')) {
      views += 1;
      return ok(JSON.stringify(views > 1 && f.prAfter ? f.prAfter : (f.pr ?? pr())));
    }
    if (key.includes('git/ref/heads/main'))
      return ok(JSON.stringify({ type: 'commit', sha: MAIN_SHA }));
    if (key.includes('/pulls/') && key.includes('/commits')) {
      const commits = f.commits ?? [
        { sha: HEAD, login: 'deefactorial', email: 'deefactorial@example.com' },
      ];
      return ok(
        commits
          .map((c) => JSON.stringify({ sha: c.sha, login: c.login, email: c.email }))
          .join('\n'),
      );
    }
    if (key.includes('/compare/')) {
      return ok(
        (f.files ?? ['CHANGELOG.md', 'pipeline-cli/package.json', '.release-please-manifest.json'])
          .map((p) => JSON.stringify({ filename: p, status: 'modified' }))
          .join('\n'),
      );
    }
    if (key.includes('pr checks')) {
      return ok(JSON.stringify(f.required ?? [{ name: 'ai-sdlc/pr-ready', state: 'SUCCESS' }]));
    }
    if (key.includes('/check-runs')) {
      return ok(
        (f.shaChecks ?? [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'success' }])
          .map((c) => JSON.stringify(c))
          .join('\n'),
      );
    }
    if (key.includes('/status')) return ok('');
    if (key.includes('pr merge')) {
      return f.mergeFails ? { stdout: '', stderr: 'boom', code: 1 } : ok('');
    }
    throw new Error(`unexpected call: ${key}`);
  };
  return { runner, calls };
}

function run(f: Fixture = {}, over: Partial<RunReleaseMergeOptions> = {}) {
  const { runner, calls } = makeRunner(f);
  const audit: ReleaseAuditRecord[] = [];
  const result = runReleaseMerge({
    prNumber: 1105,
    repoSlug: 'org/repo',
    runner,
    policyYaml: YAML,
    callerRole: 'operator',
    caller: 'tester',
    audit: (r) => audit.push(r),
    now: () => new Date('2026-10-03T12:00:00Z'),
    ...over,
  });
  return { result, calls, audit };
}

describe('runReleaseMerge: success', () => {
  it('arms a genuine release PR with squash, pinned to the head, and audits it', async () => {
    const { result, calls, audit } = run({}, { mode: 'arm' });
    const r = await result;
    expect(r.eligibility.eligible).toBe(true);
    expect(r.armed).toBe(true);
    const merge = calls.find((c) => c.includes('pr merge'))!;
    expect(merge).toContain('--auto');
    expect(merge).toContain('--squash');
    expect(merge).toContain(`--match-head-commit ${HEAD}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sourceKind: 'release',
      outcome: 'armed',
      caller: 'tester',
      callerRole: 'operator',
      prNumber: 1105,
      headSha: HEAD,
    });
  });

  it('merges (non-arm) a green + CLEAN release PR with squash', async () => {
    const { result, calls, audit } = run();
    const r = await result;
    expect(r.merged).toBe(true);
    const merge = calls.find((c) => c.includes('pr merge'))!;
    expect(merge).not.toContain('--auto');
    expect(merge).toContain('--squash');
    expect(audit[0].outcome).toBe('merged');
  });

  it('accepts the unlinked release-bot pin-sync commit alongside the release-please commit', async () => {
    const { result } = run({
      commits: [
        { sha: 'a'.repeat(40), login: 'deefactorial', email: 'x@y.z' },
        { sha: HEAD, login: null, email: RELEASE_BOT_EMAIL },
      ],
      files: ['ai-sdlc-plugin/plugin.json', 'ai-sdlc-plugin/.claude-plugin/plugin.json'],
    });
    expect((await result).merged).toBe(true);
  });

  it('dry-run never calls pr merge', async () => {
    const { result, calls, audit } = run({}, { dryRun: true });
    const r = await result;
    expect(r.eligibility.eligible).toBe(true);
    expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    expect(audit[0].outcome).toBe('dry-run');
  });
});

describe('runReleaseMerge: refusals name the failed check', () => {
  const refused = async (f: Fixture, over: Partial<RunReleaseMergeOptions> = {}) => {
    const { result, calls, audit } = run(f, over);
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.merged).toBe(false);
    if (!f.mergeFails) expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    expect(audit[0].outcome).toBe('refused');
    return r.eligibility.reason;
  };

  it('human-authored PR on the release branch name', async () => {
    const reason = await refused({ pr: pr({ author: { login: 'mallory' } }) });
    expect(reason).toMatch(/check "PR author"/);
  });

  it('a non-release head branch', async () => {
    const reason = await refused({ pr: pr({ headRefName: 'ai-sdlc/aisdlc-1-x' }) });
    expect(reason).toMatch(/check "head ref"/);
  });

  it('fork PR', async () => {
    const reason = await refused({ pr: pr({ isCrossRepository: true }) });
    expect(reason).toMatch(/check "same-repo head"/);
  });

  it('extra non-allowlisted file', async () => {
    const reason = await refused({ files: ['CHANGELOG.md', 'pipeline-cli/src/evil.ts'] });
    expect(reason).toMatch(/check "changed files".*pipeline-cli\/src\/evil\.ts/);
  });

  it('commit by a non-bot author (linked and unlinked)', async () => {
    const linked = await refused({
      commits: [{ sha: HEAD, login: 'mallory', email: 'm@x.y' }],
    });
    expect(linked).toMatch(/check "commit authors"/);
    const unlinked = await refused({
      commits: [{ sha: HEAD, login: null, email: 'someone@else.dev' }],
    });
    expect(unlinked).toMatch(/check "commit authors"/);
  });

  it('wrong base', async () => {
    const reason = await refused({ pr: pr({ baseRefName: 'develop' }) });
    expect(reason).toMatch(/check "base branch"/);
  });

  it('red required check', async () => {
    const reason = await refused({
      required: [{ name: 'ai-sdlc/pr-ready', state: 'SUCCESS' }],
      shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'failure' }],
    });
    expect(reason).toMatch(/check "required checks".*ai-sdlc\/pr-ready=FAILURE/);
  });

  it('red required check also refuses arming; pending does not', async () => {
    const red = await refused(
      { shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'failure' }] },
      { mode: 'arm' },
    );
    expect(red).toMatch(/check "required checks"/);
    const { result } = run(
      { shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'in_progress', conclusion: null }] },
      { mode: 'arm' },
    );
    expect((await result).armed).toBe(true);
  });

  it('merge mode refuses a pending check', async () => {
    const reason = await refused({
      shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'in_progress', conclusion: null }],
    });
    expect(reason).toMatch(/not green/);
  });

  it('a head that moves after verification', async () => {
    const reason = await refused({ prAfter: pr({ headRefOid: 'e'.repeat(40) }) });
    expect(reason).toMatch(/head moved/);
  });

  it('GitHub refusing the merge', async () => {
    const reason = await refused({ mergeFails: true });
    expect(reason).toMatch(/refused the merge/);
  });

  it('empty author allow-list trusts nobody', async () => {
    const reason = await refused(
      {},
      { policyYaml: 'spec:\n  governance:\n    allowMerge: never\n' },
    );
    expect(reason).toMatch(/allow-list/);
  });

  it('unreadable policy', async () => {
    const reason = await refused({}, { policyYaml: null });
    expect(reason).toMatch(/agent-role\.yaml/);
  });
});

describe('caller role (mistake guard)', () => {
  it('denies the executor role by default, before any PR is read', async () => {
    const { result, calls, audit } = run({}, { callerRole: 'executor' });
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/caller role "executor"/);
    expect(calls.some((c) => c.includes('pr view'))).toBe(false);
    expect(audit[0].callerRole).toBe('executor');
  });

  it('allows planner by default and honours governance.releaseMergeRoles', async () => {
    expect((await run({}, { callerRole: 'planner', mode: 'arm' }).result).armed).toBe(true);
    const yaml = `${YAML}    releaseMergeRoles: [operator]\n`;
    const r = await run({}, { callerRole: 'planner', policyYaml: yaml }).result;
    expect(r.eligibility.eligible).toBe(false);
  });

  it('resolveCallerRole: explicit env, active task => executor, bare => operator', () => {
    expect(resolveCallerRole({ AI_SDLC_CALLER_ROLE: 'Planner' })).toBe('planner');
    expect(resolveCallerRole({ AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' })).toBe('executor');
    expect(resolveCallerRole({})).toBe('operator');
  });

  it('resolveReleaseGovernance: defaults, fallback to mergeAuthors, drops malformed entries', () => {
    expect(resolveReleaseGovernance('spec:\n  governance:\n    mergeAuthors: [octocat]\n')).toEqual(
      {
        roles: ['operator', 'planner'],
        authors: ['octocat'],
      },
    );
    expect(
      resolveReleaseGovernance(
        'spec:\n  governance:\n    releaseAuthors: [ok, "bad login!"]\n    releaseMergeRoles: [Operator, "x y"]\n',
      ),
    ).toEqual({ roles: ['operator'], authors: ['ok'] });
    expect(resolveReleaseGovernance('')).toEqual({ roles: ['operator', 'planner'], authors: [] });
  });
});

describe('allowlist and helpers', () => {
  it('accepts release artifacts and rejects everything else', () => {
    for (const p of [
      'CHANGELOG.md',
      'pipeline-cli/CHANGELOG.md',
      '.release-please-manifest.json',
      '.claude-plugin/marketplace.json',
      'ai-sdlc-plugin/plugin.json',
      'ai-sdlc-plugin/.claude-plugin/plugin.json',
      'ai-sdlc-plugin/mcp-server/package.json',
      'orchestrator/package.json',
    ]) {
      expect(isReleaseArtifactPath(p)).toBe(true);
    }
    for (const p of ['pipeline-cli/src/x.ts', 'package.json', '.github/workflows/release.yml']) {
      expect(isReleaseArtifactPath(p)).toBe(false);
    }
  });

  it('a rename out of a non-allowlisted path is refused via previousPath', () => {
    expect(
      nonReleaseFiles([{ path: 'CHANGELOG.md', previousPath: 'src/secret.ts', status: 'renamed' }]),
    ).toEqual(['src/secret.ts']);
  });

  it('commitAuthorRefusal accepts allowed logins and the unlinked release bot only', () => {
    expect(
      commitAuthorRefusal(
        [
          { sha: 'a'.repeat(40), authorLogin: 'DeeFactorial', authorEmail: 'q' },
          { sha: 'b'.repeat(40), authorLogin: null, authorEmail: RELEASE_BOT_EMAIL.toUpperCase() },
        ],
        ['deefactorial'],
      ),
    ).toBeNull();
  });

  it('the default audit writer appends JSONL under _governance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-audit-'));
    const rec: ReleaseAuditRecord = {
      ts: '2026-10-03T00:00:00.000Z',
      event: 'release-merge',
      sourceKind: 'release',
      prNumber: 1,
      repo: 'o/r',
      caller: 'me',
      callerRole: 'operator',
      mode: 'merge',
      outcome: 'merged',
      reason: 'ok',
    };
    defaultAuditWriter(dir)(rec);
    const files = readdirSync(join(dir, '_governance'));
    expect(files).toEqual(['merge-audit-2026-10-03.jsonl']);
    expect(JSON.parse(readFileSync(join(dir, '_governance', files[0]), 'utf8').trim())).toEqual(
      rec,
    );
  });
});

describe('regressions: gh-issue refused, backlog unchanged, release never via the backlog path', () => {
  it('gh-issue stays refused by the evaluator', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'gh-issue',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/sourceKind="gh-issue" is not trusted/);
  });

  it('backlog behaviour is unchanged (green + CLEAN is eligible, wording intact)', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toMatch(/sourceKind=backlog \(trusted\)/);
  });

  it('release without the verified flag is refused by the evaluator', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'release',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(false);
  });

  it('runMergeIfEligible refuses release and gh-issue without any PR read', async () => {
    const calls: string[] = [];
    const runner: Runner = async (c, a) => {
      calls.push(`${c} ${a.join(' ')}`);
      if (a.join(' ').includes('git/ref/heads/main'))
        return { stdout: `${MAIN_SHA}\n`, stderr: '', code: 0 };
      return {
        stdout: 'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [x]\n',
        stderr: '',
        code: 0,
      };
    };
    for (const sourceKind of ['release', 'gh-issue'] as const) {
      const r = await runMergeIfEligible({
        prNumber: 1,
        sourceKind,
        repoSlug: 'org/repo',
        repoRoot: '/tmp',
        runner,
      });
      expect(r.eligibility.eligible).toBe(false);
      expect(r.merged).toBe(false);
    }
    expect(calls.some((c) => c.includes('pr view') || c.includes('pr merge'))).toBe(false);
  });
});
