import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  beginTask,
  patchFrontmatterStatus,
  renderSyntheticTaskFile,
  slugifyTaskTitle,
  syntheticTaskFilePath,
} from './04-flip-status.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import type { TaskSpec } from '../types.js';

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

  // AISDLC-393 round 2 (AC-2 fix) — synthetic task file for the gh-issue
  // path. The PreToolUse hook resolves `permittedExternalPaths` by reading
  // `<projectRoot>/backlog/tasks/<id> -*.md`. On a gh-issue dispatch there
  // is no backlog file unless we materialise one — without this synthetic
  // marker the hook returns `[]` and DENIES every external-path Write.
  describe('AISDLC-393 round 2 — synthetic task file (gh-issue + permittedExternalPaths)', () => {
    const baseSpec = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
      id: 'gh-issue-612',
      title: 'demo issue from gh',
      status: 'To Do',
      acceptanceCriteria: ['ship the feature'],
      acceptanceCriteriaChecked: [false],
      description: 'issue body',
      rawBody: 'issue body',
      filePath: '<gh-issue:612>',
      permittedExternalPaths: ['../ai-sdlc-io/'],
      ...overrides,
    });

    it('writes a synthetic file at <worktree>/backlog/tasks/<id> - <slug>.md when permittedExternalPaths is non-empty', async () => {
      const worktreePath = join(tmp, '.worktrees', 'gh-issue-612');
      mkdirSync(worktreePath, { recursive: true });

      const result = await beginTask({
        taskId: 'gh-issue-612',
        worktreePath,
        workDir: tmp,
        sourceKind: 'gh-issue',
        taskSpec: baseSpec(),
      });

      // Synthetic file path is returned in the result for executePipeline
      // to thread to Step 13 cleanup.
      const expected = join(
        worktreePath,
        'backlog',
        'tasks',
        'gh-issue-612 - demo-issue-from-gh.md',
      );
      expect(result.syntheticTaskFile).toBe(expected);
      expect(existsSync(expected)).toBe(true);

      // The file's frontmatter contains exactly what the hook needs to
      // resolve `permittedExternalPaths` (id + title + the list).
      const content = readFileSync(expected, 'utf8');
      expect(content).toContain('id: gh-issue-612');
      expect(content).toContain("title: 'demo issue from gh'");
      expect(content).toContain('permittedExternalPaths:');
      expect(content).toContain("  - '../ai-sdlc-io/'");
      // The synthetic-file warning comment ships with every render so
      // operators inspecting a stray file know what it is.
      expect(content).toMatch(/synthetic task file/i);
    });

    it('does NOT write a synthetic file when permittedExternalPaths is empty/missing', async () => {
      const worktreePath = join(tmp, '.worktrees', 'gh-issue-613');
      mkdirSync(worktreePath, { recursive: true });

      const result = await beginTask({
        taskId: 'gh-issue-613',
        worktreePath,
        workDir: tmp,
        sourceKind: 'gh-issue',
        // Spec without permittedExternalPaths — the hook isn't needed
        // for external writes, so nothing to materialise.
        taskSpec: baseSpec({ id: 'gh-issue-613', permittedExternalPaths: undefined }),
      });

      expect(result.syntheticTaskFile).toBeUndefined();
      // No synthetic file was materialised — the hook will return [] and
      // the (correctly-empty) allowlist denies external writes, matching
      // legacy behaviour for gh-issues without `permitted-external-paths`.
      expect(
        existsSync(join(worktreePath, 'backlog', 'tasks', 'gh-issue-613 - demo-issue-from-gh.md')),
      ).toBe(false);
    });

    it('does NOT write a synthetic file on the backlog path (sourceKind backlog) even with permittedExternalPaths', async () => {
      // The backlog path already has a real task file on disk; the
      // synthetic-file path is gh-issue-only.
      writeTaskFile(tmp, {
        id: 'AISDLC-393R',
        title: 'real backlog task',
        status: 'To Do',
        permittedExternalPaths: ['../ai-sdlc-io/'],
      });
      const worktreePath = join(tmp, '.worktrees', 'aisdlc-393r');
      mkdirSync(worktreePath, { recursive: true });

      const result = await beginTask({
        taskId: 'AISDLC-393R',
        worktreePath,
        workDir: tmp,
        // No sourceKind override — defaults to backlog behaviour.
        taskSpec: baseSpec({ id: 'AISDLC-393R', title: 'real backlog task' }),
      });

      expect(result.syntheticTaskFile).toBeUndefined();
      expect(
        existsSync(join(worktreePath, 'backlog', 'tasks', 'aisdlc-393r - real-backlog-task.md')),
      ).toBe(false);
    });

    it('the synthetic filename matches the hook prefix-match pattern `<id> -`', () => {
      // The hook in ai-sdlc-plugin/hooks/enforce-blocked-actions.js does:
      //   entries.find((f) => f.toLowerCase().startsWith(idLower + ' '))
      // So the filename MUST start with `<id-lower> ` (note the space).
      const spec = baseSpec({ id: 'gh-issue-99', title: 'Some Title with PUNCT!' });
      const p = syntheticTaskFilePath('/wt', spec);
      const fileName = p.split('/').pop()!;
      expect(fileName.startsWith('gh-issue-99 ')).toBe(true);
      // And the rest of the hook's lookup will find it — exercise that:
      // slug uses lowercase + non-alphanumeric → `-`.
      expect(fileName).toBe('gh-issue-99 - some-title-with-punct.md');
    });

    it('slugifyTaskTitle handles unicode + long titles defensively', () => {
      expect(slugifyTaskTitle('Hello World')).toBe('hello-world');
      expect(slugifyTaskTitle('Already-Slugged-OK')).toBe('already-slugged-ok');
      // Length cap at 50 to keep filenames sane.
      const long = 'a'.repeat(80);
      expect(slugifyTaskTitle(long).length).toBeLessThanOrEqual(50);
    });

    it('renderSyntheticTaskFile renders the minimal hook-readable frontmatter', () => {
      const content = renderSyntheticTaskFile(baseSpec());
      // YAML frontmatter delimiters present.
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('\n---\n');
      // Required fields the hook reads.
      expect(content).toContain('id: gh-issue-612');
      expect(content).toContain('permittedExternalPaths:');
      // Single-quote escape for titles containing apostrophes (YAML safety).
      const escaped = renderSyntheticTaskFile(baseSpec({ title: "Bobby's task" }));
      expect(escaped).toContain("title: 'Bobby''s task'");
    });
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
