/**
 * AISDLC-1070 — Steps 2, 3 and 11 with a fixesPr manifest against a fake `gh`: the branch is the
 * PR head ref, the worktree tracks it, the push targets it and no PR is created. A fork or a
 * protected head branch is refused with a named reason instead of falling back to a new branch.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';
import { computeBranchName } from './02-compute-branch.js';
import { setupWorktree } from './03-setup-worktree.js';
import { pushAndPr } from './11-push-and-pr.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fixes-pr-pipe-'));
});
afterEach(() => {
  removeFixtureDir(tmp);
});

const task = { id: 'AISDLC-9', title: 'Add the test', acceptanceCriteria: ['a'] } as TaskSpec;
const PR_URL = 'https://github.com/x/y/pull/1968';
const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD = 'chore/sync-runtime-pins-0-36-0';

function ghFor(info: Record<string, unknown>): FakeRunner {
  return new FakeRunner()
    .on(/^gh pr view 1968 --json headRefName/, ok(JSON.stringify(info)))
    .on(/^gh pr view 1968 --json body/, ok(JSON.stringify({ body: 'pins', url: PR_URL })))
    .on(/^git rev-parse --verify --quiet refs\/heads\//, { code: 1, stdout: '', stderr: '' })
    .on(/^git rev-parse --verify --quiet refs\/remotes\/origin\//, ok(`${SHA}\n`))
    .on(/show-toplevel/, ok(`${tmp}\n`))
    .on(/^git worktree add/, ok())
    .on(/rev-parse/, ok(`${SHA}\n`));
}

describe('fixesPr takeover through Steps 2, 3 and 11', () => {
  it('uses the PR head branch, tracks it, pushes to it and opens no PR', async () => {
    const fake = ghFor({ headRefName: HEAD, isCrossRepository: false });
    const runner = fake.toRunner();
    const b = await computeBranchName({
      taskId: 'AISDLC-9',
      task,
      workDir: tmp,
      fixesPr: 1968,
      runner,
    });
    expect(b.branch).toBe(HEAD);

    const wt = await setupWorktree({
      taskId: 'AISDLC-9',
      branch: b.branch,
      worktreePath: b.worktreePath,
      workDir: tmp,
      runner,
      skipFetch: true,
      resume: true,
    });
    expect(wt.branch).toBe(HEAD);
    const add = fake.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add?.args).toEqual(['worktree', 'add', b.worktreePath, '-b', HEAD, `origin/${HEAD}`]);

    const r = await pushAndPr({
      taskId: 'AISDLC-9',
      workDir: tmp,
      worktreePath: tmp,
      branch: b.branch,
      task,
      developerReturn: { summary: 's', filesChanged: ['a.ts'] } as unknown as DeveloperReturn,
      verdict: { decision: 'approve', verdicts: [] } as unknown as AggregatedVerdict,
      resume: true,
      fixesPr: 1968,
      resumeRemoteSha: SHA,
      resumeLeasePolicy: {
        forcePushMode: 'lease' as const,
        protectedBranches: [] as string[],
        ownWorktree: () => null,
      },
      runner,
    });
    expect(r).toEqual({ pushed: true, prUrl: PR_URL });
    expect(fake.calls.find((c) => c.args[0] === 'push')?.args).toContain(`HEAD:refs/heads/${HEAD}`);
    expect(fake.calls.some((c) => c.command === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('refuses a PR whose head is in another repository', async () => {
    const fake = ghFor({ headRefName: HEAD, isCrossRepository: true });
    await expect(
      computeBranchName({
        taskId: 'AISDLC-9',
        task,
        workDir: tmp,
        fixesPr: 1968,
        runner: fake.toRunner(),
      }),
    ).rejects.toThrow(/fixesPr #1968 refused: the PR head lives in another repository/);
  });

  it('refuses a protected head branch, from gh or from the manifest', async () => {
    const fake = ghFor({ headRefName: 'main', isCrossRepository: false });
    await expect(
      computeBranchName({
        taskId: 'AISDLC-9',
        task,
        workDir: tmp,
        fixesPr: 1968,
        runner: fake.toRunner(),
      }),
    ).rejects.toThrow(/fixesPr #1968 refused: head branch 'main' is protected/);
    await expect(
      computeBranchName({
        taskId: 'AISDLC-9',
        task,
        workDir: tmp,
        fixesPr: 1968,
        prHeadRef: 'main',
      }),
    ).rejects.toThrow(/is protected/);
  });
});
