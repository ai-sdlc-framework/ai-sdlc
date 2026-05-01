import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupWorktree } from './03-setup-worktree.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import { join } from 'node:path';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('Step 3 — setupWorktree', () => {
  it('runs fetch + worktree add and returns base SHA', async () => {
    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD/, ok('abc123\n'));
    const r = await setupWorktree({
      taskId: 'AISDLC-1',
      branch: 'ai-sdlc/aisdlc-1-test',
      worktreePath: join(tmp, '.worktrees', 'aisdlc-1'),
      workDir: tmp,
      runner: fake.toRunner(),
    });
    expect(r.branch).toBe('ai-sdlc/aisdlc-1-test');
    expect(r.baseSha).toBe('abc123');
    // Verify fetch was attempted
    expect(fake.calls.find((c) => c.command === 'git' && c.args[0] === 'fetch')).toBeDefined();
  });

  it('skips fetch when skipFetch is true', async () => {
    const fake = new FakeRunner()
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD/, ok('def456\n'));
    await setupWorktree({
      taskId: 'AISDLC-2',
      branch: 'b2',
      worktreePath: join(tmp, '.worktrees', 'aisdlc-2'),
      workDir: tmp,
      runner: fake.toRunner(),
      skipFetch: true,
    });
    expect(fake.calls.find((c) => c.command === 'git' && c.args[0] === 'fetch')).toBeUndefined();
  });

  it('throws a structured error when worktree add fails (e.g. branch exists)', async () => {
    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git worktree add/, fail("fatal: a branch named 'b' already exists", 128));
    await expect(
      setupWorktree({
        taskId: 'AISDLC-3',
        branch: 'b',
        worktreePath: join(tmp, '.worktrees', 'aisdlc-3'),
        workDir: tmp,
        runner: fake.toRunner(),
      }),
    ).rejects.toThrow(/branch already exists|cleanup AISDLC-3/);
  });
});
