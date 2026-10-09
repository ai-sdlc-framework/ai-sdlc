/**
 * AISDLC-738 — end-to-end: `executePipeline` on a task whose claimed board
 * manifest carries resume feedback re-enters the existing worktree and branch,
 * injects the feedback into the developer prompt and updates the existing PR.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from './dispatch/board.js';
import { completeTask } from './dispatch/complete.js';
import { resumeDone } from './dispatch/resume.js';
import { executePipeline } from './execute-pipeline.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import { FakeRunner, ok } from './__test-helpers/fake-runner.js';
import { computeBranchName } from './steps/02-compute-branch.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { validateTask } from './steps/01-validate.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const dev: DeveloperReturn = {
  summary: 'fixed coverage',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
  notes: '',
};
const approved = (type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer') => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'lgtm' },
  status: 'success' as const,
  durationMs: 0,
});

describe('executePipeline on a resumed task', () => {
  it('reuses the worktree, carries the feedback, and updates the existing PR', async () => {
    const taskPath = writeTaskFile(tmp, {
      id: 'AISDLC-100',
      title: 'resume demo',
      status: 'In Progress',
      acceptanceCriteria: ['ship it'],
    });
    const v = await validateTask({ taskId: 'AISDLC-100', workDir: tmp });
    const branch = await computeBranchName({ taskId: 'AISDLC-100', task: v.task!, workDir: tmp });

    // The finished first round left the worktree behind, with the task already in completed/.
    const wt = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(join(wt, 'backlog', 'completed'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: x');
    copyFileSync(taskPath, join(wt, 'backlog', 'completed', 'aisdlc-100 - resume-demo.md'));
    const parentBefore = readFileSync(taskPath, 'utf8');

    // Board: the task was finished, then resumed and claimed again.
    const board = join(tmp, '.ai-sdlc', 'dispatch');
    writeManifest(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-100',
      branch: branch.branch,
      worktree: '.worktrees/aisdlc-100',
      baseSha: 'abc',
      workerKind: 'in-session-agent',
      dispatchedAt: '2026-10-09T00:00:00Z',
      dispatchedBy: 't',
      spec: { taskFile: 'x', verifyCommands: [] },
    });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec' });
    completeTask(board, {
      taskId: 'AISDLC-100',
      outcome: 'success',
      workerId: 'exec',
      prNumber: 55,
    });
    resumeDone(
      board,
      'AISDLC-100',
      { note: 'Coverage is below 80 percent', failingChecks: ['coverage'] },
      { resumedBy: 'dispatch' },
    );
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec' });

    const prompts: string[] = [];
    const spawner = new MockSpawner({
      developer: (opts) => {
        prompts.push(opts.prompt);
        return { type: 'developer', output: '', parsed: dev, status: 'success', durationMs: 0 };
      },
      'code-reviewer': approved('code-reviewer'),
      'test-reviewer': approved('test-reviewer'),
      'security-reviewer': approved('security-reviewer'),
    });
    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/rev-parse --abbrev-ref HEAD/, ok(`${branch.branch}\n`))
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
      .on(
        /^gh pr list/,
        ok(JSON.stringify([{ number: 55, isDraft: true, url: 'https://github.com/o/r/pull/55' }])),
      )
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('--- diff content ---\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('a.ts\0'),
      );
    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner,
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    // AC5: existing worktree and branch, never created from origin/main.
    expect(runner.calls.some((c) => c.args[0] === 'worktree')).toBe(false);
    expect(
      runner.calls.some((c) => c.args.includes('origin/main') && c.args[0] === 'worktree'),
    ).toBe(false);
    // AC5: the parent checkout's task file is untouched.
    expect(readFileSync(taskPath, 'utf8')).toBe(parentBefore);
    // AC5: the existing PR is updated through a lease push, no new PR.
    expect(result.prUrl).toBe('https://github.com/o/r/pull/55');
    expect(runner.calls.some((c) => c.command === 'gh' && c.args[1] === 'create')).toBe(false);
    expect(runner.calls.find((c) => c.args[0] === 'push')?.args).toContain('--force-with-lease');
    // AC6: the feedback is in the developer prompt.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Coverage is below 80 percent');
    expect(prompts[0]).toContain('pull request #55');
    expect(prompts[0]).toContain('- coverage');
    // AC7: reviewers ran again.
    expect(spawner.getCallCount('code-reviewer')).toBeGreaterThan(0);
    // Step 13 cleaned the sentinel as on a first run.
    expect(existsSync(join(wt, '.active-task'))).toBe(false);
  });
});
