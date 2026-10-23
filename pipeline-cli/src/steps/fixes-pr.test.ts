/**
 * AISDLC-1054 — a manifest with fixesPr runs on the PR's head branch, pushes to it,
 * appends to the PR body and opens no new PR; without fixesPr nothing changes.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import { enqueueTasks } from '../dispatch/enqueue.js';
import { briefToEnqueueEntries } from '../hierarchy/dispatch-loop.js';
import { parseBrief, renderBriefBlock } from '../hierarchy/brief-format.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';
import { computeBranchName } from './02-compute-branch.js';
import { pushAndPr } from './11-push-and-pr.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fixes-pr-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const task = { id: 'AISDLC-9', title: 'Add the test', acceptanceCriteria: ['a'] } as TaskSpec;
const PR_URL = 'https://github.com/x/y/pull/1907';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Step 2 with fixesPr', () => {
  it('uses the manifest prHeadRef without calling gh', async () => {
    const fake = new FakeRunner();
    const r = await computeBranchName({
      taskId: 'AISDLC-9',
      task,
      workDir: tmp,
      fixesPr: 1907,
      prHeadRef: 'feat/the-pr',
      runner: fake.toRunner(),
    });
    expect(r.branch).toBe('feat/the-pr');
    expect(r.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-9'));
    expect(fake.calls).toHaveLength(0);
  });

  it('reads the head branch with gh pr view when the manifest has none', async () => {
    const fake = new FakeRunner().on(/^gh pr view 1907/, ok('{"headRefName":"feat/the-pr"}'));
    const r = await computeBranchName({
      taskId: 'AISDLC-9',
      task,
      workDir: tmp,
      fixesPr: 1907,
      runner: fake.toRunner(),
    });
    expect(r.branch).toBe('feat/the-pr');
  });

  it('throws when gh fails, prints junk, or returns an option-shaped name', async () => {
    for (const out of [fail('nope'), ok('not json'), ok('{"headRefName":"--upload-pack=x"}')]) {
      const fake = new FakeRunner().on(/^gh pr view/, out);
      await expect(
        computeBranchName({
          taskId: 'AISDLC-9',
          task,
          workDir: tmp,
          fixesPr: 3,
          runner: fake.toRunner(),
        }),
      ).rejects.toThrow(/could not resolve the head branch of PR #3/);
    }
  });

  it('without fixesPr the branch is still derived from the task', async () => {
    const r = await computeBranchName({ taskId: 'AISDLC-9', task, workDir: tmp });
    expect(r.branch).toBe('ai-sdlc/aisdlc-9-add-the-test');
  });
});

describe('Step 11 with fixesPr', () => {
  const dev = { summary: 's', filesChanged: ['a.ts'] } as unknown as DeveloperReturn;
  const verdict = { decision: 'approve', verdicts: [] } as unknown as AggregatedVerdict;
  const common = () => ({
    taskId: 'AISDLC-9',
    workDir: tmp,
    worktreePath: tmp,
    branch: 'feat/the-pr',
    task,
    developerReturn: dev,
    verdict,
    resume: true,
    fixesPr: 1907,
    resumeRemoteSha: SHA,
    resumeLeasePolicy: {
      forcePushMode: 'leaseOnOwnBranch' as const,
      protectedBranches: [] as string[],
      ownWorktree: () => null,
    },
  });

  it('lease-pushes to the PR branch, appends to the body and creates no PR', async () => {
    const fake = new FakeRunner().on(
      /^gh pr view 1907/,
      ok(JSON.stringify({ body: 'Original body', url: PR_URL })),
    );
    const r = await pushAndPr({ ...common(), runner: fake.toRunner() });
    expect(r).toEqual({ pushed: true, prUrl: PR_URL });
    expect(fake.calls.find((c) => c.args[0] === 'push')?.args).toEqual([
      'push',
      '-u',
      `--force-with-lease=refs/heads/feat/the-pr:${SHA}`,
      'origin',
      'HEAD:refs/heads/feat/the-pr',
    ]);
    expect(fake.calls.some((c) => c.command === 'gh' && c.args[1] === 'create')).toBe(false);
    const edit = fake.calls.find((c) => c.command === 'gh' && c.args[1] === 'edit');
    expect(edit?.args[2]).toBe('1907');
    expect(edit?.args[4]).toBe('Original body\n\nFixed by AISDLC-9\n');
  });

  it('does not append the line twice', async () => {
    const fake = new FakeRunner().on(
      /^gh pr view/,
      ok(JSON.stringify({ body: 'x\n\nFixed by AISDLC-9\n', url: PR_URL })),
    );
    await pushAndPr({ ...common(), runner: fake.toRunner() });
    expect(fake.calls.some((c) => c.command === 'gh' && c.args[1] === 'edit')).toBe(false);
  });

  it('survives a failed body edit and reports an unreadable PR', async () => {
    const edit = new FakeRunner()
      .on(/^gh pr view/, ok(JSON.stringify({ url: PR_URL })))
      .on(/^gh pr edit/, fail('boom'));
    expect((await pushAndPr({ ...common(), runner: edit.toRunner() })).prUrl).toBe(PR_URL);
    const view = new FakeRunner().on(/^gh pr view/, fail('gone'));
    const r = await pushAndPr({ ...common(), runner: view.toRunner() });
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBeNull();
    expect(r.reason).toContain('gh pr view failed');
  });

  it('without fixesPr a normal task still opens its PR', async () => {
    const fake = new FakeRunner().on(/^gh pr create/, ok('https://github.com/x/y/pull/20\n'));
    const { fixesPr: _f, resume: _r, ...rest } = common();
    const r = await pushAndPr({ ...rest, runner: fake.toRunner() });
    expect(r.prUrl).toBe('https://github.com/x/y/pull/20');
    expect(fake.calls.some((c) => c.command === 'gh' && c.args[1] === 'create')).toBe(true);
  });
});

describe('brief to manifest', () => {
  it('carries fixesPr and the PR head branch from the brief into the manifest', () => {
    const block = renderBriefBlock([
      { task: 'AISDLC-9', after: [], wave: 1, fixesPr: 1907, prHeadRef: 'feat/the-pr' },
    ]);
    const entries = briefToEnqueueEntries(parseBrief(block));
    expect(entries[0]).toMatchObject({ fixesPr: 1907, prHeadRef: 'feat/the-pr' });
    const rel = 'backlog/tasks/AISDLC-9 - Add the test.md';
    mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(tmp, rel), '---\nid: AISDLC-9\ntitle: Add the test\nstatus: To Do\n---\n');
    const [written] = enqueueTasks(join(tmp, 'board'), entries, {
      baseSha: 'abc',
      dispatchedBy: 't',
      resolveTaskFile: () => rel,
      workDir: tmp,
    });
    expect(JSON.parse(readFileSync(written!, 'utf8'))).toMatchObject({
      branch: 'feat/the-pr',
      fixesPr: 1907,
      prHeadRef: 'feat/the-pr',
    });
  });

  it('rejects a malformed fixesPr or prHeadRef', () => {
    const bad = (extra: string) =>
      '```yaml\ndispatchBrief:\n  - task: AISDLC-9\n    wave: 1\n    ' + extra + '\n```';
    expect(() => parseBrief(bad('fixesPr: 0'))).toThrow(/fixesPr/);
    expect(() => parseBrief(bad('prHeadRef: "a..b"'))).toThrow(/prHeadRef/);
    expect(() => parseBrief(bad('prHeadRef: 5'))).toThrow(/prHeadRef/);
  });
});
