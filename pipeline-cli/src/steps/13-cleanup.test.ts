import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTask } from './13-cleanup.js';
import { syntheticTaskFilePath } from './04-flip-status.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type { TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('Step 13 — cleanupTask', () => {
  it('removes the per-worktree sentinel when present', async () => {
    const wt = join(tmp, '.worktrees', 'aisdlc-1');
    mkdirSync(wt, { recursive: true });
    const sentinel = join(wt, '.active-task');
    writeFileSync(sentinel, 'AISDLC-1\n', 'utf8');

    const r = await cleanupTask({ taskId: 'AISDLC-1', worktreePath: wt });
    expect(r.sentinelRemoved).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('reports false when sentinel was already gone (idempotent)', async () => {
    const wt = join(tmp, '.worktrees', 'absent');
    mkdirSync(wt, { recursive: true });
    const r = await cleanupTask({ taskId: 'X', worktreePath: wt });
    expect(r.sentinelRemoved).toBe(false);
    expect(r.syntheticTaskFileRemoved).toBe(false);
  });

  // AISDLC-393 round 2 (AC-2 fix) — Step 13 also removes the synthetic
  // gh-issue task file Step 4 materialised. The synthetic file MUST NOT
  // land in the PR; this cleanup is the audit-trail-friendly alternative
  // to gitignoring `backlog/tasks/gh-issue-*`. Two surfaces:
  //   1. caller threads the path through `opts.syntheticTaskFile`
  //   2. caller passes `opts.taskSpec` and we re-derive the path
  // Both are idempotent.
  describe('AISDLC-393 round 2 — synthetic gh-issue task file cleanup', () => {
    const ghSpec: TaskSpec = {
      id: 'gh-issue-612',
      title: 'demo issue',
      status: 'In Progress',
      acceptanceCriteria: ['x'],
      acceptanceCriteriaChecked: [false],
      description: '',
      rawBody: '',
      filePath: '<gh-issue:612>',
      permittedExternalPaths: ['../ai-sdlc-io/'],
    };

    it('removes a synthetic file when path is threaded via opts.syntheticTaskFile', async () => {
      const wt = join(tmp, '.worktrees', 'gh-issue-612');
      mkdirSync(join(wt, 'backlog', 'tasks'), { recursive: true });
      const synthPath = syntheticTaskFilePath(wt, ghSpec);
      writeFileSync(synthPath, 'irrelevant content', 'utf8');

      const r = await cleanupTask({
        taskId: 'gh-issue-612',
        worktreePath: wt,
        syntheticTaskFile: synthPath,
      });
      expect(r.syntheticTaskFileRemoved).toBe(true);
      expect(existsSync(synthPath)).toBe(false);
    });

    it('re-derives the synthetic path from opts.taskSpec when path is not threaded', async () => {
      const wt = join(tmp, '.worktrees', 'gh-issue-612b');
      mkdirSync(join(wt, 'backlog', 'tasks'), { recursive: true });
      const synthPath = syntheticTaskFilePath(wt, { ...ghSpec, id: 'gh-issue-612b' });
      writeFileSync(synthPath, 'irrelevant content', 'utf8');

      const r = await cleanupTask({
        taskId: 'gh-issue-612b',
        worktreePath: wt,
        // No syntheticTaskFile — Step 13 re-derives via taskSpec.
        taskSpec: { ...ghSpec, id: 'gh-issue-612b' },
      });
      expect(r.syntheticTaskFileRemoved).toBe(true);
      expect(existsSync(synthPath)).toBe(false);
    });

    it('is idempotent when the synthetic file was already removed (pre-push cleanup ran)', async () => {
      const wt = join(tmp, '.worktrees', 'gh-issue-612c');
      mkdirSync(wt, { recursive: true });
      const synthPath = syntheticTaskFilePath(wt, { ...ghSpec, id: 'gh-issue-612c' });
      // Synthetic file was already removed by pre-push cleanup; Step 13
      // should report syntheticTaskFileRemoved=false but NOT throw.
      const r = await cleanupTask({
        taskId: 'gh-issue-612c',
        worktreePath: wt,
        syntheticTaskFile: synthPath,
      });
      expect(r.syntheticTaskFileRemoved).toBe(false);
    });

    it('reports false on the backlog path (no synthetic file is ever created)', async () => {
      const wt = join(tmp, '.worktrees', 'backlog-task');
      mkdirSync(wt, { recursive: true });
      const sentinel = join(wt, '.active-task');
      writeFileSync(sentinel, 'AISDLC-1\n', 'utf8');

      const r = await cleanupTask({
        taskId: 'AISDLC-1',
        worktreePath: wt,
        // No syntheticTaskFile + no taskSpec — backlog path.
      });
      expect(r.sentinelRemoved).toBe(true);
      expect(r.syntheticTaskFileRemoved).toBe(false);
    });

    it('cleans both sentinel AND synthetic file in a single call', async () => {
      const wt = join(tmp, '.worktrees', 'gh-issue-614');
      mkdirSync(join(wt, 'backlog', 'tasks'), { recursive: true });
      writeFileSync(join(wt, '.active-task'), 'gh-issue-614\n', 'utf8');
      const synthPath = syntheticTaskFilePath(wt, { ...ghSpec, id: 'gh-issue-614' });
      writeFileSync(synthPath, 'content', 'utf8');

      const r = await cleanupTask({
        taskId: 'gh-issue-614',
        worktreePath: wt,
        syntheticTaskFile: synthPath,
      });
      expect(r.sentinelRemoved).toBe(true);
      expect(r.syntheticTaskFileRemoved).toBe(true);
      expect(existsSync(join(wt, '.active-task'))).toBe(false);
      expect(existsSync(synthPath)).toBe(false);
    });
  });
});
