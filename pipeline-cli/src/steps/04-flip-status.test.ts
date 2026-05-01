import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginTask, patchFrontmatterStatus } from './04-flip-status.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('Step 4 — patchFrontmatterStatus', () => {
  it('replaces an existing status: line', () => {
    const raw = `---\nid: X\nstatus: To Do\n---\n\nbody\n`;
    const out = patchFrontmatterStatus(raw, 'In Progress');
    expect(out).toContain('status: In Progress');
    expect(out).not.toContain('status: To Do');
    expect(out).toContain('body');
  });

  it('appends status: line when missing', () => {
    const raw = `---\nid: X\n---\n\nbody\n`;
    const out = patchFrontmatterStatus(raw, 'Done');
    expect(out).toContain('status: Done');
  });

  it('preserves other frontmatter keys verbatim (no upstream stripping)', () => {
    const raw = `---\nid: X\nstatus: To Do\npermittedExternalPaths:\n  - '../sib/'\n---\n\n`;
    const out = patchFrontmatterStatus(raw, 'In Progress');
    expect(out).toContain('permittedExternalPaths:');
    expect(out).toContain("  - '../sib/'");
  });

  it('throws when frontmatter delimiters are missing', () => {
    expect(() => patchFrontmatterStatus('not a task file', 'In Progress')).toThrow(/frontmatter/);
  });
});

describe('Step 4 — beginTask', () => {
  it('flips status + writes per-worktree sentinel', async () => {
    const taskFile = writeTaskFile(tmp, { id: 'AISDLC-1', title: 'demo', status: 'To Do' });
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-1');
    mkdirSync(worktreePath, { recursive: true });

    const r = await beginTask({ taskId: 'AISDLC-1', worktreePath, workDir: tmp });
    expect(r.sentinelPath).toBe(join(worktreePath, '.active-task'));

    const updated = readFileSync(taskFile, 'utf8');
    expect(updated).toContain('status: In Progress');

    const sentinel = readFileSync(r.sentinelPath, 'utf8');
    expect(sentinel.trim()).toBe('AISDLC-1');
  });

  it('throws when task file is absent', async () => {
    const worktreePath = join(tmp, '.worktrees', 'missing');
    mkdirSync(worktreePath, { recursive: true });
    await expect(beginTask({ taskId: 'AISDLC-NOPE', worktreePath, workDir: tmp })).rejects.toThrow(
      /no task file/,
    );
  });

  it('respects status override (test-only)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-2', title: 'two', status: 'To Do' });
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-2');
    mkdirSync(worktreePath, { recursive: true });
    await beginTask({ taskId: 'AISDLC-2', worktreePath, workDir: tmp, status: 'Blocked' });
    const taskFile = join(tmp, 'backlog', 'tasks', 'aisdlc-2 - two.md');
    expect(readFileSync(taskFile, 'utf8')).toContain('status: Blocked');
  });
});
