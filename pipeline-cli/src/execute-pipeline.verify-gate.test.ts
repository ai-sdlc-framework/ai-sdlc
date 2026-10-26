/**
 * AISDLC-1078 — step 6 runs the manifest's verifyCommands and gates on exit status.
 */
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimNext, writeManifest } from './dispatch/board.js';
import { executePipeline } from './execute-pipeline.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from './__test-helpers/fake-runner.js';
import { computeBranchName } from './steps/02-compute-branch.js';
import { validateTask } from './steps/01-validate.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
beforeEach(() => {
  process.env.AI_SDLC_REVIEWER_SET = 'three';
  tmp = makeTmpProject();
});
afterEach(() => {
  delete process.env.AI_SDLC_REVIEWER_SET;
  cleanupTmpProject(tmp);
});

const green: DeveloperReturn = {
  summary: 'shipped',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
};

async function arrange(verifyCommands: string[]): Promise<void> {
  writeTaskFile(tmp, {
    id: 'AISDLC-100',
    title: 'verify gate',
    status: 'To Do',
    acceptanceCriteria: ['ship it'],
  });
  mkdirSync(join(tmp, '.worktrees', 'aisdlc-100'), { recursive: true });
  const v = await validateTask({ taskId: 'AISDLC-100', workDir: tmp });
  const branch = await computeBranchName({ taskId: 'AISDLC-100', task: v.task!, workDir: tmp });
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
    spec: { taskFile: 'x', verifyCommands },
  });
  claimNext(board, 'in-session-agent', undefined, { workerId: 'exec' });
}

function runner(testResult = ok()): FakeRunner {
  return new FakeRunner()
    .on((c, a) => c === 'sh' && a[1] === 'pnpm test', testResult)
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git -c core\.quotePath=false diff --text/, ok('--- diff ---\n'))
    .on(/^git -c core\.quotePath=false diff --name-only/, ok('a.ts\0'))
    .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));
}

const reviewer = (type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer') => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'lgtm' },
  status: 'success' as const,
  durationMs: 0,
});

describe('step 6 verify gate', () => {
  it('routes a red command back to step 5 and never builds a reviewer', async () => {
    await arrange(['pnpm test']);
    const prompts: string[] = [];
    const spawner = new MockSpawner({
      developer: (o) => {
        prompts.push(o.prompt);
        return { type: 'developer', output: '', parsed: green, status: 'success', durationMs: 0 };
      },
      'code-reviewer': reviewer('code-reviewer'),
      'test-reviewer': reviewer('test-reviewer'),
      'security-reviewer': reviewer('security-reviewer'),
    });
    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner,
      runner: runner(fail('1 failing test\n')).toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 1,
    });
    expect(result.outcome).toBe('developer-failed');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('pnpm test');
    expect(prompts[1]).toContain('1 failing test');
    expect(spawner.getCallCount('code-reviewer')).toBe(0);
    const state = JSON.parse(
      readFileSync(join(tmp, '.ai-sdlc', 'artifacts', 'verify-runs', 'AISDLC-100.json'), 'utf8'),
    );
    expect(state.verifications.test).toBe('failed');
    expect(state.developerClaimed.test).toBe('passed');
    expect(existsSync(join(tmp, '.ai-sdlc', 'usage', 'developer-honesty.jsonl'))).toBe(true);
  });

  it('skips docs-only tasks and proceeds to review', async () => {
    await arrange([]);
    const spawner = new MockSpawner({
      developer: { type: 'developer', output: '', parsed: green, status: 'success', durationMs: 0 },
      'code-reviewer': reviewer('code-reviewer'),
      'test-reviewer': reviewer('test-reviewer'),
      'security-reviewer': reviewer('security-reviewer'),
    });
    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner,
      runner: runner().toRunner(),
      skipFinalizeCommit: true,
    });
    expect(result.outcome).toBe('approved');
    const state = JSON.parse(
      readFileSync(join(tmp, '.ai-sdlc', 'artifacts', 'verify-runs', 'AISDLC-100.json'), 'utf8'),
    );
    expect(state.skipped).toBe('docs-only');
  });

  it('proceeds to review when every command exits 0', async () => {
    await arrange(['pnpm test']);
    const spawner = new MockSpawner({
      developer: { type: 'developer', output: '', parsed: green, status: 'success', durationMs: 0 },
      'code-reviewer': reviewer('code-reviewer'),
      'test-reviewer': reviewer('test-reviewer'),
      'security-reviewer': reviewer('security-reviewer'),
    });
    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner,
      runner: runner().toRunner(),
      skipFinalizeCommit: true,
    });
    expect(result.outcome).toBe('approved');
  });
});
