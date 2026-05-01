import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTask } from './13-cleanup.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';

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
  });
});
