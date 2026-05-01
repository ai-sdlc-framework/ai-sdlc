import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sweepMergedWorktrees } from './00-sweep.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('Step 0 — sweepMergedWorktrees', () => {
  it('returns empty when .worktrees does not exist', async () => {
    const result = await sweepMergedWorktrees({ workDir: '/nonexistent/path/abcdef' });
    expect(result.swept).toEqual([]);
  });

  it('skips worktrees with no PR or unmerged PR', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-1'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('feature/branch-a\n'))
      .on(/^gh pr list/, ok('null')); // no merged PR

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('removes worktrees whose PR is merged', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-1'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-1-test\n'))
      .on(/^gh pr list/, ok('2026-04-30T12:00:00Z'))
      .on(/^git worktree remove/, ok());

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].branch).toBe('ai-sdlc/aisdlc-1-test');
    expect(result.swept[0].mergedAt).toBe('2026-04-30T12:00:00Z');
  });

  it('skips detached HEAD worktrees (HEAD branch name)', async () => {
    mkdirSync(join(tmp, '.worktrees', 'detached'), { recursive: true });
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('HEAD\n'));

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('handles non-zero git exit by skipping the entry', async () => {
    mkdirSync(join(tmp, '.worktrees', 'broken'), { recursive: true });
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, {
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });
});
