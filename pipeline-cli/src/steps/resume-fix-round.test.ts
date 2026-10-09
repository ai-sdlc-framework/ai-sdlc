/**
 * AISDLC-738 — a resumed task re-enters its existing worktree and branch,
 * carries its feedback into the developer prompt, and updates its existing PR.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';
import { isTaskFileCompleted } from './01-validate.js';
import { setupWorktree } from './03-setup-worktree.js';
import { beginTask } from './04-flip-status.js';
import { buildDeveloperPrompt } from './05-build-dev-prompt.js';
import { pushAndPr } from './11-push-and-pr.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'resume-steps-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const BRANCH = 'ai-sdlc/aisdlc-9-slug';

describe('Step 3 resume', () => {
  const wt = (): string => join(tmp, '.worktrees', 'aisdlc-9');
  const base = () => ({
    taskId: 'AISDLC-9',
    branch: BRANCH,
    worktreePath: wt(),
    workDir: tmp,
    resume: true,
  });

  it('reuses the existing worktree without creating or resetting anything', async () => {
    mkdirSync(wt(), { recursive: true });
    writeFileSync(join(wt(), '.git'), 'gitdir: x');
    const fake = new FakeRunner()
      .on(/rev-parse --abbrev-ref HEAD/, ok(`${BRANCH}\n`))
      .on(/rev-parse HEAD/, ok('abc\n'));
    const r = await setupWorktree({ ...base(), runner: fake.toRunner() });
    expect(r.baseSha).toBe('abc');
    expect(fake.calls.some((c) => c.args[0] === 'worktree')).toBe(false);
    expect(fake.calls.some((c) => c.args.includes('origin/main'))).toBe(false);
    // The branch (not main) was fetched.
    expect(fake.calls.find((c) => c.args[0] === 'fetch')?.args).toEqual([
      'fetch',
      'origin',
      BRANCH,
    ]);
  });

  it('refuses a worktree sitting on another branch', async () => {
    mkdirSync(wt(), { recursive: true });
    writeFileSync(join(wt(), '.git'), 'gitdir: x');
    const fake = new FakeRunner().on(/rev-parse --abbrev-ref HEAD/, ok('other\n'));
    await expect(setupWorktree({ ...base(), runner: fake.toRunner() })).rejects.toThrow(
      /not 'ai-sdlc\/aisdlc-9-slug'/,
    );
  });

  it('recreates the worktree from the local branch', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --verify --quiet refs\/heads/, ok('sha\n'))
      .on(/rev-parse HEAD/, ok('abc\n'));
    await setupWorktree({ ...base(), runner: fake.toRunner() });
    const add = fake.calls.find((c) => c.args[0] === 'worktree');
    expect(add?.args).toEqual(['worktree', 'add', wt(), BRANCH]);
  });

  it('recreates the worktree from origin/<branch>, never from origin/main', async () => {
    const fake = new FakeRunner()
      .on(/refs\/heads/, fail('', 1))
      .on(/refs\/remotes\/origin/, ok('sha\n'))
      .on(/rev-parse HEAD/, ok('abc\n'));
    await setupWorktree({ ...base(), runner: fake.toRunner() });
    const add = fake.calls.find((c) => c.args[0] === 'worktree');
    expect(add?.args).toEqual(['worktree', 'add', wt(), '-b', BRANCH, `origin/${BRANCH}`]);
    expect(add?.args).not.toContain('origin/main');
  });

  it('throws when the branch exists nowhere, and when worktree add fails', async () => {
    const none = new FakeRunner().on(/rev-parse --verify/, fail('', 1));
    await expect(setupWorktree({ ...base(), runner: none.toRunner() })).rejects.toThrow(
      /nothing to resume/,
    );
    const bad = new FakeRunner()
      .on(/rev-parse --verify/, ok('sha\n'))
      .on(/^git worktree add/, fail('fatal: locked', 128));
    await expect(setupWorktree({ ...base(), runner: bad.toRunner() })).rejects.toThrow(
      /worktree add failed while resuming/,
    );
  });

  it('skips the fetch with skipFetch', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --verify --quiet refs\/heads/, ok('sha\n'))
      .on(/rev-parse HEAD/, ok('abc\n'));
    await setupWorktree({ ...base(), runner: fake.toRunner(), skipFetch: true });
    expect(fake.calls.some((c) => c.args[0] === 'fetch')).toBe(false);
  });
});

describe('Step 4 resume', () => {
  const taskFm = '---\nid: AISDLC-9\ntitle: t\nstatus: Done\n---\nbody\n';

  it('rewrites the .active-task sentinel and leaves a completed task file alone', async () => {
    const wt = join(tmp, 'wt');
    mkdirSync(join(wt, 'backlog', 'completed'), { recursive: true });
    const file = join(wt, 'backlog', 'completed', 'aisdlc-9 - t.md');
    writeFileSync(file, taskFm);
    expect(isTaskFileCompleted('AISDLC-9', wt)).toBe(true);
    const r = await beginTask({ taskId: 'AISDLC-9', worktreePath: wt, workDir: tmp, resume: true });
    expect(readFileSync(r.sentinelPath, 'utf8')).toBe('AISDLC-9\n');
    expect(readFileSync(file, 'utf8')).toBe(taskFm);
  });

  it('without resume, a completed-only task still fails as before', async () => {
    const wt = join(tmp, 'wt2');
    mkdirSync(join(wt, 'backlog', 'completed'), { recursive: true });
    writeFileSync(join(wt, 'backlog', 'completed', 'aisdlc-9 - t.md'), taskFm);
    await expect(beginTask({ taskId: 'AISDLC-9', worktreePath: wt, workDir: tmp })).rejects.toThrow(
      /no task file found/,
    );
  });

  it('isTaskFileCompleted is false when the file is still in tasks/ or missing', () => {
    expect(isTaskFileCompleted('AISDLC-9', tmp)).toBe(false);
    mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(tmp, 'backlog', 'tasks', 'aisdlc-9 - t.md'), taskFm);
    expect(isTaskFileCompleted('AISDLC-9', tmp)).toBe(false);
  });
});

const task: TaskSpec = {
  id: 'AISDLC-9',
  title: 'Title',
  status: 'Done',
  description: 'desc',
  acceptanceCriteria: ['one'],
  rawBody: 'body',
  filePath: '/x',
} as unknown as TaskSpec;

describe('Step 5 resume', () => {
  it('injects the feedback into the developer prompt', async () => {
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-9',
      task,
      branch: BRANCH,
      worktreePath: '/wt',
      resumeFeedback: 'Update pull request #12.\n\nFailing checks:\n- coverage',
      artifactsDir: tmp,
    });
    expect(r.prompt).toContain('## Resumed task: feedback to address');
    expect(r.prompt).toContain('Update pull request #12.');
    expect(r.prompt).toContain('- coverage');
  });

  it('adds nothing without feedback', async () => {
    const r = await buildDeveloperPrompt({
      taskId: 'AISDLC-9',
      task,
      branch: BRANCH,
      worktreePath: '/wt',
      artifactsDir: tmp,
    });
    expect(r.prompt).not.toContain('Resumed task');
  });
});

describe('Step 11 resume', () => {
  const dev = { summary: 's', filesChanged: ['a.ts'] } as unknown as DeveloperReturn;
  const verdict = { decision: 'approve', verdicts: [] } as unknown as AggregatedVerdict;
  const common = () => ({
    taskId: 'AISDLC-9',
    workDir: tmp,
    worktreePath: tmp,
    branch: BRANCH,
    task,
    developerReturn: dev,
    verdict,
  });

  it('lease-pushes to its own branch and returns the existing PR without creating one', async () => {
    const fake = new FakeRunner().on(
      /^gh pr list/,
      ok(JSON.stringify([{ number: 12, isDraft: false, url: 'https://github.com/x/y/pull/12' }])),
    );
    const r = await pushAndPr({ ...common(), resume: true, runner: fake.toRunner() });
    expect(r).toEqual({ pushed: true, prUrl: 'https://github.com/x/y/pull/12' });
    const push = fake.calls.find((c) => c.args[0] === 'push');
    expect(push?.args).toEqual([
      'push',
      '-u',
      '--force-with-lease',
      'origin',
      `HEAD:refs/heads/${BRANCH}`,
    ]);
    expect(fake.calls.some((c) => c.command === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('opens a PR when the resumed branch has none', async () => {
    const fake = new FakeRunner()
      .on(/^gh pr list/, ok('[]'))
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/13\n'));
    const r = await pushAndPr({ ...common(), resume: true, runner: fake.toRunner() });
    expect(r.prUrl).toBe('https://github.com/x/y/pull/13');
  });

  it('a first run pushes without a lease, as before', async () => {
    const fake = new FakeRunner().on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    await pushAndPr({ ...common(), runner: fake.toRunner() });
    expect(fake.calls.find((c) => c.args[0] === 'push')?.args).toEqual([
      'push',
      '-u',
      'origin',
      BRANCH,
    ]);
  });
});
