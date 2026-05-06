/**
 * Tests for Step 0.5 — syncParentUntrackedFiles + helpers.
 *
 * All tests are hermetic: a FakeRunner scripts git/gh invocations and a
 * temporary filesystem directory is created per test for any real I/O.
 *
 * Coverage:
 *   (a) 3 untracked task files in parent → opens 1 sync PR with all 3
 *   (b) 1 untracked random file (not in backlog/) → surfaces error (ok: false)
 *   (c) 1 untracked file matching an already-on-origin path → skipped (ok: true + skippedReason)
 *   (d) parent fully clean (no untracked files) → no-op (ok: true, syncedFiles: [])
 *   (e) parent dirty with backlog files + non-backlog files → refuses + surfaces error
 *   (f) git worktree add fails → ok: false with reason
 *   (g) git push fails → ok: false with reason
 *   (h) gh pr create fails → ok: false (but syncedFiles populated)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncParentUntrackedFiles,
  listUntrackedFiles,
  isFileOnOriginMain,
} from './00-5-sync-parent.js';
import { FakeRunner, ok, fail as fakeRunnerFail } from '../__test-helpers/fake-runner.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-step05-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(workDir, 'backlog', 'completed'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── Helper unit tests ─────────────────────────────────────────────────

describe('listUntrackedFiles', () => {
  it('returns empty array on git failure (code !== 0)', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, fakeRunnerFail('not a git repo', 128));
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual([]);
  });

  it('parses newline-separated output into an array', async () => {
    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/tasks/aisdlc-1 - foo.md\nbacklog/tasks/aisdlc-2 - bar.md\n'),
    );
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual(['backlog/tasks/aisdlc-1 - foo.md', 'backlog/tasks/aisdlc-2 - bar.md']);
  });

  it('filters blank lines', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok('\nbacklog/tasks/aisdlc-1 - foo.md\n\n'));
    const result = await listUntrackedFiles(workDir, fake.toRunner());
    expect(result).toEqual(['backlog/tasks/aisdlc-1 - foo.md']);
  });
});

describe('isFileOnOriginMain', () => {
  it('returns true when ls-tree returns a non-empty path', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main/,
      ok('backlog/tasks/aisdlc-1 - foo.md\n'),
    );
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-1 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(true);
  });

  it('returns false when ls-tree returns empty output (file not on origin)', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(false);
  });

  it('returns false when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await isFileOnOriginMain(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe(false);
  });
});

// ── syncParentUntrackedFiles integration tests ────────────────────────

describe('Step 0.5 — syncParentUntrackedFiles', () => {
  it('(d) parent fully clean → no-op (ok: true, syncedFiles: [])', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok(''));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.prUrl).toBeUndefined();
    expect(result.skippedReason).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('(b) 1 untracked random file (not in backlog/) → surfaces error', async () => {
    const fake = new FakeRunner().on(/^git ls-files/, ok('dist/index.js\n'));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-backlog untracked files/);
    expect(result.reason).toContain('dist/index.js');
    expect(result.syncedFiles).toEqual([]);
  });

  it('(e) backlog + non-backlog untracked files → refuses with error listing non-backlog', async () => {
    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/tasks/aisdlc-99 - new.md\norphan-artifact.json\n'),
    );
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-backlog untracked files/);
    expect(result.reason).toContain('orphan-artifact.json');
    // backlog file not listed in reason (only non-backlog files are the problem)
    expect(result.syncedFiles).toEqual([]);
  });

  it('(c) 1 untracked file already on origin/main → skipped (ok: true + skippedReason)', async () => {
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-10 - existing.md\n'))
      .on(/^git ls-tree origin\/main/, ok('backlog/tasks/aisdlc-10 - existing.md\n'));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/already on origin\/main/);
  });

  it('(a) 3 untracked task files in parent → opens 1 sync PR with all 3', async () => {
    // Create dummy task files in workDir so copyFileSync can read them
    const taskFiles = [
      'backlog/tasks/aisdlc-100 - task-a.md',
      'backlog/tasks/aisdlc-101 - task-b.md',
      'backlog/completed/aisdlc-102 - task-c.md',
    ];
    for (const f of taskFiles) {
      writeFileSync(join(workDir, f), `# ${f}\ncontent`, 'utf8');
    }

    const untrackedOutput = taskFiles.join('\n') + '\n';

    const fake = new FakeRunner()
      // git ls-files returns 3 task files
      .on(/^git ls-files/, ok(untrackedOutput))
      // None are on origin/main
      .on(/^git ls-tree origin\/main/, ok(''))
      // rev-parse for short sha
      .on(/^git rev-parse --short/, ok('abc12345\n'))
      // git worktree add succeeds
      .on(/^git worktree add/, ok())
      // git add succeeds
      .on(/^git add --/, ok())
      // git commit succeeds
      .on(/^git commit/, ok())
      // git push succeeds
      .on(/^git push -u origin chore\/sync-tasks/, ok())
      // gh pr create returns a URL
      .on(/^gh pr create/, ok('https://github.com/org/repo/pull/999\n'))
      // git worktree remove for cleanup
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toHaveLength(3);
    expect(result.syncedFiles).toEqual(expect.arrayContaining(taskFiles));
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/999');
    expect(result.skippedReason).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('(a) only genuinely-new files are synced (already-on-origin files excluded)', async () => {
    const taskFiles = [
      'backlog/tasks/aisdlc-200 - new.md',
      'backlog/tasks/aisdlc-201 - existing.md',
    ];
    for (const f of taskFiles) {
      writeFileSync(join(workDir, f), `# ${f}\ncontent`, 'utf8');
    }

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(taskFiles.join('\n') + '\n'))
      // aisdlc-200 is NOT on origin
      .on(/^git ls-tree origin\/main .+aisdlc-200/, ok(''))
      // aisdlc-201 IS on origin
      .on(/^git ls-tree origin\/main .+aisdlc-201/, ok('backlog/tasks/aisdlc-201 - existing.md\n'))
      .on(/^git rev-parse --short/, ok('def67890\n'))
      .on(/^git worktree add/, ok())
      .on(/^git add --/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, ok())
      .on(/^gh pr create/, ok('https://github.com/org/repo/pull/1000\n'))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toHaveLength(1);
    expect(result.syncedFiles[0]).toContain('aisdlc-200');
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1000');
  });

  it('(f) git worktree add fails → ok: false with reason', async () => {
    writeFileSync(join(workDir, 'backlog/tasks/aisdlc-300 - new.md'), '# content', 'utf8');
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-300 - new.md\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('aaa11111\n'))
      .on(/^git worktree add/, fakeRunnerFail('branch already exists', 128))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to create sync worktree/);
    expect(result.syncedFiles).toEqual([]);
  });

  it('(g) git push fails → ok: false with reason, syncedFiles still contains new files', async () => {
    writeFileSync(join(workDir, 'backlog/tasks/aisdlc-400 - new.md'), '# content', 'utf8');
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-400 - new.md\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('bbb22222\n'))
      .on(/^git worktree add/, ok())
      .on(/^git add --/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, fakeRunnerFail('rejected: non-fast-forward', 1))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to push sync branch/);
    expect(result.syncedFiles).toContain('backlog/tasks/aisdlc-400 - new.md');
  });

  it('(h) gh pr create fails → ok: false (but syncedFiles populated)', async () => {
    writeFileSync(join(workDir, 'backlog/tasks/aisdlc-500 - new.md'), '# content', 'utf8');
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-500 - new.md\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('ccc33333\n'))
      .on(/^git worktree add/, ok())
      .on(/^git add --/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, ok())
      .on(/^gh pr create/, fakeRunnerFail('rate limited', 1))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/gh pr create failed/);
    expect(result.syncedFiles).toContain('backlog/tasks/aisdlc-500 - new.md');
  });

  it('uses correct branch naming pattern chore/sync-tasks-<sha>', async () => {
    writeFileSync(join(workDir, 'backlog/tasks/aisdlc-600 - new.md'), '# content', 'utf8');

    // Capture what worktree branch is created
    const worktreeCalls: string[] = [];
    const capturingFake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-600 - new.md\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('deadbeef\n'))
      .on(/^git worktree add/, (args) => {
        worktreeCalls.push(...args);
        return { stdout: '', stderr: '', code: 0 };
      })
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, ok())
      .on(/^gh pr create/, ok('https://github.com/org/repo/pull/1\n'))
      .on(/^git worktree remove/, ok());

    await syncParentUntrackedFiles({ workDir, runner: capturingFake.toRunner() });
    // The branch passed to worktree add should contain our sha
    expect(worktreeCalls.join(' ')).toContain('chore/sync-tasks-deadbeef');
  });

  it('does NOT block on non-ok results from git ls-files (clean + non-backlog)', async () => {
    // Verify that the step still proceeds if git ls-files errors (returns empty)
    const fake = new FakeRunner().on(/^git ls-files/, fakeRunnerFail('not a git repo', 128));
    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });
    // git error → treated as no untracked files → clean no-op
    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
  });
});
