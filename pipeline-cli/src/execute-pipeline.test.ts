/**
 * Integration test — full Step 0-13 pipeline against MockSpawner + FakeRunner.
 *
 * No real git/gh/network. The injected `Runner` scripts the side-effect surface
 * (worktree create, push, PR open, sibling repo ops). The injected `MockSpawner`
 * fakes the LLM dispatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { executePipeline } from './execute-pipeline.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { defaultSpawner } from './runtime/default-spawner.js';
import { ShellClaudePSpawner } from './runtime/shell-claude-p-spawner.js';
import { ClaudeCodeSDKSpawner } from './runtime/claude-code-sdk-spawner.js';
import { FakeRunner, ok, fail } from './__test-helpers/fake-runner.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const goodDev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
  notes: 'no follow-up',
};

const approvedReviewer = (type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer') => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'lgtm' },
  status: 'success' as const,
  durationMs: 0,
});

function makeApprovingSpawner(dev: DeveloperReturn = goodDev): MockSpawner {
  return new MockSpawner({
    developer: {
      type: 'developer',
      output: '',
      parsed: dev,
      status: 'success',
      durationMs: 0,
    },
    'code-reviewer': approvedReviewer('code-reviewer'),
    'test-reviewer': approvedReviewer('test-reviewer'),
    'security-reviewer': approvedReviewer('security-reviewer'),
  });
}

function makeHappyRunner(): FakeRunner {
  return new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
    .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));
}

describe('integration — executePipeline (full Step 0-13)', () => {
  it('happy path: validate → setup → developer → 3 reviews approve → finalize → push → cleanup', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-100',
      title: 'integration demo task',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing', 'verify it works'],
    });

    // Pre-create the worktree dir so beginTask's sentinel write succeeds (since
    // FakeRunner doesn't actually run `git worktree add`).
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-100'), { recursive: true });

    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true, // tmp is not a real git repo
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result.iterations).toBe(1);
    expect(result.finalVerdict?.decision).toBe('APPROVED');

    // Step 13 cleanup ran — sentinel removed
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-100', '.active-task'))).toBe(false);

    // Task moved to completed/
    expect(
      existsSync(join(tmp, 'backlog', 'completed', 'aisdlc-100 - integration-demo-task.md')),
    ).toBe(true);
  });

  it('developer-failed path: returns developer-failed outcome without opening PR', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-101',
      title: 'broken developer',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-101'), { recursive: true });

    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: { ...goodDev, commitSha: null, notes: 'could not finish' },
        status: 'success',
        durationMs: 0,
      },
    });
    const result = await executePipeline({
      taskId: 'AISDLC-101',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('developer-failed');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/null commitSha|could not finish/);
  });

  it('validation failure: returns aborted before opening any worktree', async () => {
    // No task file written — validation will fail with `no task file`.
    const result = await executePipeline({
      taskId: 'AISDLC-NOPE',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
    });
    expect(result.outcome).toBe('aborted');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/no task file/);
  });

  it('needs-human-attention path: cap reached, PR opens with the flag', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-102',
      title: 'persistent broken',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-102'), { recursive: true });

    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: goodDev,
        status: 'success',
        durationMs: 0,
      },
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: {
          approved: false,
          findings: [{ severity: 'critical', message: 'still broken' }],
          summary: '',
        },
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': approvedReviewer('test-reviewer'),
      'security-reviewer': approvedReviewer('security-reviewer'),
    });
    const result = await executePipeline({
      taskId: 'AISDLC-102',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });
    expect(result.outcome).toBe('needs-human-attention');
    expect(result.iterations).toBe(2);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  it('push-failure path: push fails non-fast-forward → aborted with reason', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-103',
      title: 'push failure',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-103'), { recursive: true });

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok())
      .on(/^git diff --name-only/, ok())
      .on(/^git push -u origin/, fail('! [rejected] (non-fast-forward)\nerror: failed to push', 1));

    const result = await executePipeline({
      taskId: 'AISDLC-103',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/non-fast-forward/);
  });

  it('throws when no spawner is provided', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-X', title: 'x', status: 'To Do' });
    await expect(
      executePipeline({
        taskId: 'AISDLC-X',
        workDir: tmp,
        runner: makeHappyRunner().toRunner(),
      } as Parameters<typeof executePipeline>[0]),
    ).rejects.toThrow(/requires opts.spawner/);
  });

  it('cleanup runs even when push fails (try/finally guarantee)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-104', title: 'cleanup-after-fail', status: 'To Do' });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-104'), { recursive: true });

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok())
      .on(/^git diff/, ok())
      .on(/^git push -u origin/, fail('non-fast-forward', 1));

    const result = await executePipeline({
      taskId: 'AISDLC-104',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-104', '.active-task'))).toBe(false);
  });
});

describe('integration — defaultSpawner picks the right spawner per environment', () => {
  it('picks ShellClaudePSpawner when claude CLI is available', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(true),
      env: () => undefined,
    });
    expect(spawner).toBeInstanceOf(ShellClaudePSpawner);
  });

  it('picks ClaudeCodeSDKSpawner when only ANTHROPIC_API_KEY is set', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'sk-ant-test',
    });
    expect(spawner).toBeInstanceOf(ClaudeCodeSDKSpawner);
  });

  it('throws clearly when neither runtime is available', async () => {
    await expect(
      defaultSpawner({
        which: vi.fn().mockResolvedValue(false),
        env: () => undefined,
      }),
    ).rejects.toThrow(/install the `claude` CLI|set ANTHROPIC_API_KEY/);
  });

  it('the default spawner is interchangeable with MockSpawner in executePipeline (smoke)', async () => {
    // Use a mock-backed defaultSpawner via the SDK invoker injection so we
    // exercise the full pipeline against a default-resolved spawner without
    // touching network or shell. This proves the resolved spawner satisfies
    // the SubagentSpawner contract end-to-end (Step 5b + Step 7b).
    writeTaskFile(tmp, {
      id: 'AISDLC-200',
      title: 'default spawner smoke',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200'), { recursive: true });

    // Defer to the SDK path via env, but inject a mock invoker so no real SDK
    // call is made.
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'sk-ant-test',
      sdk: {
        invoker: vi.fn().mockImplementation(async ({ type }: { type: string }) => {
          if (type === 'developer') {
            return {
              output: '',
              parsed: {
                summary: 'shipped',
                filesChanged: ['x.ts'],
                commitSha: 'abc1234',
                verifications: {
                  build: 'passed',
                  test: 'passed',
                  lint: 'passed',
                  format: 'passed',
                },
                acceptanceCriteriaMet: [1],
                notes: '',
              },
            };
          }
          return { output: '', parsed: { approved: true, findings: [], summary: 'lgtm' } };
        }),
      },
    });

    const result = await executePipeline({
      taskId: 'AISDLC-200',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });
});
