import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  // ── AISDLC-199 — worktree-local lifecycle edits ─────────────────────
  //
  // When BOTH the parent workDir and the worktree contain the task file
  // (the realistic shape after Step 3 checks out a fresh copy from
  // origin/main), beginTask MUST patch the worktree-local copy and leave
  // the parent's copy byte-identical. The failure mode this regression
  // guards against is the AISDLC-199 bug: the parent checkout was left
  // with an uncommitted `status: In Progress` edit that blocked
  // `scripts/check-orchestrator-state.sh` from running its
  // `git reset --hard origin/main` sync between dispatches.
  it('AISDLC-199: prefers the worktree-local task file when both copies exist', async () => {
    // Parent (operator checkout) — status: To Do, original.
    const parentPath = writeTaskFile(tmp, {
      id: 'AISDLC-199',
      title: 'worktree-preference',
      status: 'To Do',
    });
    const parentBefore = readFileSync(parentPath, 'utf8');

    // Worktree (per-task fresh checkout from origin/main) — also a copy of
    // the same task file, also status: To Do. Real Step 3 produces this
    // by `git worktree add ... origin/main`.
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-199');
    mkdirSync(join(worktreePath, 'backlog', 'tasks'), { recursive: true });
    const worktreeTaskPath = join(
      worktreePath,
      'backlog',
      'tasks',
      'aisdlc-199 - worktree-preference.md',
    );
    writeFileSync(worktreeTaskPath, parentBefore, 'utf8');

    await beginTask({ taskId: 'AISDLC-199', worktreePath, workDir: tmp });

    // Parent copy MUST be byte-identical to its pre-dispatch state.
    expect(readFileSync(parentPath, 'utf8')).toBe(parentBefore);
    expect(readFileSync(parentPath, 'utf8')).toContain('status: To Do');

    // Worktree copy MUST have the In Progress flip applied.
    expect(readFileSync(worktreeTaskPath, 'utf8')).toContain('status: In Progress');
  });

  // AISDLC-393 — gh-issue source skips the backlog frontmatter patch but
  // still writes the sentinel. The PreToolUse hook needs the sentinel
  // regardless of source kind, but there's no on-disk file to patch.
  it('AISDLC-393: gh-issue source skips frontmatter patch + still writes sentinel', async () => {
    const worktreePath = join(tmp, '.worktrees', 'gh-issue-612');
    mkdirSync(worktreePath, { recursive: true });
    // Crucially: NO backlog file exists for `gh-issue-612` — the issue is
    // the source of truth. The previous (file-loading) path would throw
    // here with `no task file found`; the gh-issue branch must NOT throw.

    const r = await beginTask({
      taskId: 'gh-issue-612',
      worktreePath,
      workDir: tmp,
      sourceKind: 'gh-issue',
    });

    expect(r.sentinelPath).toBe(join(worktreePath, '.active-task'));
    const sentinel = readFileSync(r.sentinelPath, 'utf8');
    expect(sentinel.trim()).toBe('gh-issue-612');
  });

  it('AISDLC-199: falls back to workDir when the worktree has no task file', async () => {
    // Standalone CLI invocation path — operator runs `pipeline-cli begin-task`
    // with `--worktree-path` pointing somewhere that doesn't have the file.
    // Step 4 must still flip the parent's copy so the legacy path keeps
    // working.
    const parentPath = writeTaskFile(tmp, {
      id: 'AISDLC-199b',
      title: 'fallback-to-parent',
      status: 'To Do',
    });
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-199b');
    mkdirSync(worktreePath, { recursive: true });
    // Note: NO `backlog/tasks/` inside the worktree — fallback to workDir.

    await beginTask({ taskId: 'AISDLC-199b', worktreePath, workDir: tmp });

    expect(readFileSync(parentPath, 'utf8')).toContain('status: In Progress');
  });
});
