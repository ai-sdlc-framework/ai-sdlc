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
 *   (i) AISDLC-222: local tasks/ + origin completed/ → path-mismatch, skip with log
 *   (j) AISDLC-222: local completed/ + origin tasks/ → symmetric path-mismatch, skip with log
 *   (k) AISDLC-222: auto-reconcile opt-in deletes stale local copy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncParentUntrackedFiles,
  listUntrackedFiles,
  isFileOnOriginMain,
  findPathMismatchOnOrigin,
  isFileOnOriginMainInAnyDir,
  pruneStaleParentDebris,
  extractTaskId,
  findCompletedCounterpartOnOrigin,
  readOriginMainFile,
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

  it('reserves the sync worktree path WITHOUT pre-creating the directory (regression)', async () => {
    // Regression: an earlier version called mkdtempSync but never removed the
    // empty dir it created. `git worktree add` requires the destination to NOT
    // exist (it creates the dir itself), so every live invocation failed with
    // "destination path already exists". FakeRunner can't catch this because
    // it never execs git — instead, capture the path argument inside the
    // `worktree add` matcher and assert existsSync(path) === false at the
    // exact moment git would run.
    writeFileSync(join(workDir, 'backlog/tasks/aisdlc-700 - new.md'), '# content', 'utf8');

    let capturedPath: string | undefined;
    let pathExistedAtAddTime: boolean | undefined;
    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-700 - new.md\n'))
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('eee44444\n'))
      .on(/^git worktree add/, (args) => {
        // worktree add args: ['worktree', 'add', <path>, '-b', <branch>, 'origin/main']
        capturedPath = args[2];
        pathExistedAtAddTime = existsSync(capturedPath);
        // After git would have created it, simulate by mkdir so the subsequent
        // copyFileSync calls have a real directory to write into.
        mkdirSync(capturedPath, { recursive: true });
        return { stdout: '', stderr: '', code: 0 };
      })
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, ok())
      .on(/^gh pr create/, ok('https://github.com/org/repo/pull/700\n'))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(capturedPath).toBeDefined();
    expect(capturedPath).toMatch(/ai-sdlc-sync-parent-/);
    expect(pathExistedAtAddTime).toBe(false);
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

// ── AISDLC-222: Path-mismatch helper unit tests ──────────────────────

describe('findPathMismatchOnOrigin', () => {
  it('returns found: true with canonicalPath when basename exists in completed/ on origin', async () => {
    // Local file is in tasks/, but on origin/main it's in completed/
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+completed\/aisdlc-10/,
      ok('backlog/completed/aisdlc-10 - done.md\n'),
    );
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-10 - done.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.canonicalPath).toBe('backlog/completed/aisdlc-10 - done.md');
    }
  });

  it('returns found: true with canonicalPath when basename exists in tasks/ on origin (symmetric)', async () => {
    // Local file is in completed/, but on origin/main it's still in tasks/
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+tasks\/aisdlc-11/,
      ok('backlog/tasks/aisdlc-11 - in-progress.md\n'),
    );
    const result = await findPathMismatchOnOrigin(
      'backlog/completed/aisdlc-11 - in-progress.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.canonicalPath).toBe('backlog/tasks/aisdlc-11 - in-progress.md');
    }
  });

  it('returns found: false when alternate directory check finds nothing', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-99 - new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(false);
  });

  it('returns found: false for a non-backlog path', async () => {
    const fake = new FakeRunner(); // no expectations needed
    const result = await findPathMismatchOnOrigin('src/some-file.ts', workDir, fake.toRunner());
    expect(result.found).toBe(false);
  });

  it('returns found: false when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await findPathMismatchOnOrigin(
      'backlog/tasks/aisdlc-12 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.found).toBe(false);
  });
});

describe('isFileOnOriginMainInAnyDir', () => {
  it('returns exactMatch:true when file is on origin at the exact same path', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+tasks\/aisdlc-20/,
      ok('backlog/tasks/aisdlc-20 - foo.md\n'),
    );
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-20 - foo.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(true);
    expect(result.exactMatch).toBe(true);
    expect(result.canonicalPath).toBe('backlog/tasks/aisdlc-20 - foo.md');
  });

  it('returns exactMatch:false + onOrigin:true when file is on origin at alternate path', async () => {
    const fake = new FakeRunner()
      // Exact path check: tasks/ → not found
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-21/, ok(''))
      // Alternate path check: completed/ → found
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-21/,
        ok('backlog/completed/aisdlc-21 - done.md\n'),
      );
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-21 - done.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(true);
    expect(result.exactMatch).toBe(false);
    expect(result.canonicalPath).toBe('backlog/completed/aisdlc-21 - done.md');
  });

  it('returns onOrigin:false when file is not on origin in any directory', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main/, ok(''));
    const result = await isFileOnOriginMainInAnyDir(
      'backlog/tasks/aisdlc-99 - brand-new.md',
      workDir,
      fake.toRunner(),
    );
    expect(result.onOrigin).toBe(false);
    expect(result.exactMatch).toBe(false);
    expect(result.canonicalPath).toBeNull();
  });
});

// ── AISDLC-222: Path-mismatch integration tests ──────────────────────

describe('Step 0.5 — path-mismatch reconciliation (AISDLC-222)', () => {
  it('(i) local tasks/aisdlc-N + origin completed/aisdlc-N → skip with log (no sync PR)', async () => {
    // Local: backlog/tasks/aisdlc-10 - done.md
    // Origin: only backlog/completed/aisdlc-10 - done.md
    writeFileSync(
      join(workDir, 'backlog/tasks/aisdlc-10 - done.md'),
      '# aisdlc-10\ncontent',
      'utf8',
    );

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-10 - done.md\n'))
      // Exact path check: tasks/ → NOT on origin
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-10/, ok(''))
      // Alternate path check: completed/ → FOUND (path-mismatch)
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-10/,
        ok('backlog/completed/aisdlc-10 - done.md\n'),
      );

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-10 - done.md']);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/path-mismatched/);
    // Verify log line was emitted
    const mismatchLog = logLines.find(
      (l) => l.includes('[step-0.5]') && l.includes('stale local copy'),
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain('backlog/tasks/aisdlc-10 - done.md');
    expect(mismatchLog).toContain('backlog/completed/aisdlc-10 - done.md');
  });

  it('(j) local completed/aisdlc-N + origin tasks/aisdlc-N → symmetric path-mismatch, skip with log', async () => {
    // Symmetric case: operator promoted locally but main hasn't caught up
    writeFileSync(
      join(workDir, 'backlog/completed/aisdlc-11 - in-progress.md'),
      '# aisdlc-11\ncontent',
      'utf8',
    );

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/completed/aisdlc-11 - in-progress.md\n'))
      // Exact path check: completed/ → NOT on origin
      .on(/^git ls-tree origin\/main .+completed\/aisdlc-11/, ok(''))
      // Alternate path check: tasks/ → FOUND (symmetric path-mismatch)
      .on(
        /^git ls-tree origin\/main .+tasks\/aisdlc-11/,
        ok('backlog/tasks/aisdlc-11 - in-progress.md\n'),
      );

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toEqual([]);
    expect(result.pathMismatchedFiles).toEqual(['backlog/completed/aisdlc-11 - in-progress.md']);
    expect(result.skippedReason).toBeDefined();
    expect(result.skippedReason).toMatch(/path-mismatched/);
    // Verify log line was emitted
    const mismatchLog = logLines.find(
      (l) => l.includes('[step-0.5]') && l.includes('stale local copy'),
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog).toContain('backlog/completed/aisdlc-11 - in-progress.md');
    expect(mismatchLog).toContain('backlog/tasks/aisdlc-11 - in-progress.md');
  });

  it('genuinely new file (not on origin anywhere) is NOT treated as path-mismatch', async () => {
    writeFileSync(
      join(workDir, 'backlog/tasks/aisdlc-999 - brand-new.md'),
      '# aisdlc-999\ncontent',
      'utf8',
    );

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-999 - brand-new.md\n'))
      // Neither exact nor alternate path found on origin
      .on(/^git ls-tree origin\/main/, ok(''))
      .on(/^git rev-parse --short/, ok('abc12345\n'))
      .on(/^git worktree add/, ok())
      .on(/^git add --/, ok())
      .on(/^git commit/, ok())
      .on(/^git push/, ok())
      .on(/^gh pr create/, ok('https://github.com/org/repo/pull/1001\n'))
      .on(/^git worktree remove/, ok());

    const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.syncedFiles).toHaveLength(1);
    expect(result.syncedFiles[0]).toContain('aisdlc-999');
    expect(result.pathMismatchedFiles).toBeUndefined();
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1001');
  });

  it('(k) AI_SDLC_STEP_0_5_AUTO_RECONCILE=1: deletes stale local copy when set', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-50 - done.md');
    writeFileSync(staleFile, '# aisdlc-50\ncontent', 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    // Set the auto-reconcile env var
    const originalEnv = process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
    process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = '1';

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-50 - done.md\n'))
      // Exact path: NOT found
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-50/, ok(''))
      // Alternate path: FOUND
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-50/,
        ok('backlog/completed/aisdlc-50 - done.md\n'),
      )
      // git rm fails (file is untracked, not staged) → fallback to direct delete
      .on(/^git rm/, fakeRunnerFail('not tracked', 128));

    try {
      const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

      expect(result.ok).toBe(true);
      expect(result.syncedFiles).toEqual([]);
      expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-50 - done.md']);
      // The file should have been deleted by the auto-reconcile fallback
      expect(existsSync(staleFile)).toBe(false);
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
      } else {
        process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = originalEnv;
      }
    }
  });

  it('(k) auto-reconcile NOT triggered when env var is unset', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-51 - done.md');
    writeFileSync(staleFile, '# aisdlc-51\ncontent', 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const originalEnv = process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
    delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-51 - done.md\n'))
      .on(/^git ls-tree origin\/main .+tasks\/aisdlc-51/, ok(''))
      .on(
        /^git ls-tree origin\/main .+completed\/aisdlc-51/,
        ok('backlog/completed/aisdlc-51 - done.md\n'),
      );

    try {
      const result = await syncParentUntrackedFiles({ workDir, runner: fake.toRunner() });

      expect(result.ok).toBe(true);
      expect(result.pathMismatchedFiles).toEqual(['backlog/tasks/aisdlc-51 - done.md']);
      // File should NOT have been deleted (auto-reconcile not enabled)
      expect(existsSync(staleFile)).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'];
      } else {
        process.env['AI_SDLC_STEP_0_5_AUTO_RECONCILE'] = originalEnv;
      }
    }
  });
});

// ── AISDLC-446: pruneStaleParentDebris unit tests ─────────────────────────────

describe('extractTaskId', () => {
  it('extracts lowercase task ID from backlog/tasks/ path', () => {
    expect(extractTaskId('backlog/tasks/aisdlc-446 - some-slug.md')).toBe('aisdlc-446');
  });

  it('extracts lowercase task ID from backlog/completed/ path', () => {
    expect(extractTaskId('backlog/completed/AISDLC-100 - foo.md')).toBe('aisdlc-100');
  });

  it('returns null for a non-backlog path', () => {
    expect(extractTaskId('src/some-file.ts')).toBeNull();
  });

  it('returns null for a path without the numeric suffix', () => {
    expect(extractTaskId('backlog/tasks/README.md')).toBeNull();
  });
});

describe('findCompletedCounterpartOnOrigin', () => {
  it('returns the completed/ path when a same-ID file exists on origin/main', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok(
        'backlog/completed/aisdlc-446 - prune-stale-debris.md\nbacklog/completed/aisdlc-447 - other.md\n',
      ),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBe('backlog/completed/aisdlc-446 - prune-stale-debris.md');
  });

  it('returns null when no same-ID file exists in completed/', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok('backlog/completed/aisdlc-999 - other.md\n'),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('returns null when completed/ directory is empty on origin', async () => {
    const fake = new FakeRunner().on(/^git ls-tree origin\/main .+backlog\/completed\//, ok(''));
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('returns null when git ls-tree exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git ls-tree/, fakeRunnerFail('error', 128));
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    expect(result).toBeNull();
  });

  it('matches case-insensitively (AISDLC vs aisdlc)', async () => {
    const fake = new FakeRunner().on(
      /^git ls-tree origin\/main .+backlog\/completed\//,
      ok('backlog/completed/AISDLC-446 - prune-stale-debris.md\n'),
    );
    const result = await findCompletedCounterpartOnOrigin('aisdlc-446', workDir, fake.toRunner());
    // The file from origin is returned as-is; the match is by ID equality
    expect(result).toBe('backlog/completed/AISDLC-446 - prune-stale-debris.md');
  });
});

describe('readOriginMainFile', () => {
  it('returns content string on success', async () => {
    const fake = new FakeRunner().on(
      /^git show origin\/main:/,
      ok('---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n'),
    );
    const result = await readOriginMainFile(
      'backlog/completed/aisdlc-446 - slug.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBe('---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n');
  });

  it('returns null when git show exits non-zero', async () => {
    const fake = new FakeRunner().on(/^git show/, fakeRunnerFail('not found', 128));
    const result = await readOriginMainFile(
      'backlog/completed/aisdlc-446 - slug.md',
      workDir,
      fake.toRunner(),
    );
    expect(result).toBeNull();
  });
});

// ── AISDLC-446: pruneStaleParentDebris integration tests ──────────────────────

describe('pruneStaleParentDebris — AISDLC-446', () => {
  const CONTENT_MATCH = '---\nid: AISDLC-446\nstatus: Done\n---\n\n## Body\n\nDone.\n';
  const CONTENT_LOCAL_EDIT =
    '---\nid: AISDLC-446\nstatus: To Do\n---\n\n## Body\n\nEdited locally.\n';

  it('AC#3 — clean-delete: content matches → deletes the stale tasks/ file', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-446 - prune-stale-debris.md');
    writeFileSync(staleFile, CONTENT_MATCH, 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      // git ls-files returns the stale file
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-446 - prune-stale-debris.md\n'))
      // git ls-tree for completed/ listing returns the counterpart
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - prune-stale-debris.md\n'),
      )
      // git show returns same content as local file
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual(['backlog/tasks/aisdlc-446 - prune-stale-debris.md']);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    // File should have been deleted
    expect(existsSync(staleFile)).toBe(false);
    // One log line should have been emitted
    const pruneLog = logLines.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('pruned'),
    );
    expect(pruneLog).toBeDefined();
    expect(pruneLog).toContain('backlog/tasks/aisdlc-446');
  });

  it('AC#4 — content-mismatch-skip: content differs → logs warning, leaves file intact', async () => {
    const staleFile = join(workDir, 'backlog/tasks/aisdlc-446 - prune-stale-debris.md');
    writeFileSync(staleFile, CONTENT_LOCAL_EDIT, 'utf8');
    expect(existsSync(staleFile)).toBe(true);

    const warnLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-446 - prune-stale-debris.md\n'))
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - prune-stale-debris.md\n'),
      )
      // git show returns DIFFERENT content
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([
      'backlog/tasks/aisdlc-446 - prune-stale-debris.md',
    ]);
    expect(result.noCounterpart).toEqual([]);
    // File must NOT have been deleted
    expect(existsSync(staleFile)).toBe(true);
    // Warning must have been emitted
    const warnLog = warnLines.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('content differs'),
    );
    expect(warnLog).toBeDefined();
  });

  it('AC#5 — no-counterpart-no-op: no completed/ counterpart → leaves file alone, no output', async () => {
    const taskFile = join(workDir, 'backlog/tasks/aisdlc-999 - brand-new.md');
    writeFileSync(taskFile, CONTENT_MATCH, 'utf8');
    expect(existsSync(taskFile)).toBe(true);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok('backlog/tasks/aisdlc-999 - brand-new.md\n'))
      // completed/ listing returns no same-ID file
      .on(/^git ls-tree origin\/main .+backlog\/completed\//, ok(''));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual(['backlog/tasks/aisdlc-999 - brand-new.md']);
    // File should still exist
    expect(existsSync(taskFile)).toBe(true);
    // No prune-stale-debris log lines
    const pruneLines = [...logLines, ...warnLines].filter((l) =>
      l.includes('[prune-stale-debris]'),
    );
    expect(pruneLines).toHaveLength(0);
  });

  it('AC#6 — idempotent: no untracked task files → no-op, no output', async () => {
    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnLines.push(msg);
    });

    const fake = new FakeRunner().on(/^git ls-files/, ok(''));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    const pruneLines = [...logLines, ...warnLines].filter((l) =>
      l.includes('[prune-stale-debris]'),
    );
    expect(pruneLines).toHaveLength(0);
  });

  it('AC#9 — one log line per pruned file, silent when no debris', async () => {
    // Create two stale files with matching content
    const staleFile1 = join(workDir, 'backlog/tasks/aisdlc-100 - stale-a.md');
    const staleFile2 = join(workDir, 'backlog/tasks/aisdlc-101 - stale-b.md');
    writeFileSync(staleFile1, CONTENT_MATCH, 'utf8');
    writeFileSync(staleFile2, CONTENT_MATCH, 'utf8');

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    const fake = new FakeRunner()
      .on(
        /^git ls-files/,
        ok('backlog/tasks/aisdlc-100 - stale-a.md\nbacklog/tasks/aisdlc-101 - stale-b.md\n'),
      )
      // Both have counterparts in completed/
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok(
          'backlog/completed/aisdlc-100 - stale-a.md\nbacklog/completed/aisdlc-101 - stale-b.md\n',
        ),
      )
      // Both have identical content
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    consoleSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toHaveLength(2);
    // Exactly one log line per pruned file
    const pruneLogLines = logLines.filter(
      (l) => l.includes('[prune-stale-debris]') && l.includes('pruned'),
    );
    expect(pruneLogLines).toHaveLength(2);
    expect(existsSync(staleFile1)).toBe(false);
    expect(existsSync(staleFile2)).toBe(false);
  });

  it('only targets backlog/tasks/ files, not backlog/completed/ untracked files', async () => {
    // An untracked file in backlog/completed/ should NOT be pruned
    writeFileSync(
      join(workDir, 'backlog/completed/aisdlc-200 - in-completed.md'),
      CONTENT_MATCH,
      'utf8',
    );

    const fake = new FakeRunner().on(
      /^git ls-files/,
      ok('backlog/completed/aisdlc-200 - in-completed.md\n'),
    );
    // Should not need to call ls-tree since the file doesn't match tasks/ pattern
    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.noCounterpart).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([]);
    // The completed/ file should still exist
    expect(existsSync(join(workDir, 'backlog/completed/aisdlc-200 - in-completed.md'))).toBe(true);
  });

  it('skips when local readFileSync throws (file vanished between ls-files and read)', async () => {
    const phantomFile = 'backlog/tasks/aisdlc-446 - phantom.md';
    expect(existsSync(join(workDir, phantomFile))).toBe(false);

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warnings.push(msg);
    });

    const fake = new FakeRunner()
      .on(/^git ls-files/, ok(`${phantomFile}\n`))
      .on(
        /^git ls-tree origin\/main .+backlog\/completed\//,
        ok('backlog/completed/aisdlc-446 - phantom.md\n'),
      )
      .on(/^git show origin\/main:/, ok(CONTENT_MATCH));

    const result = await pruneStaleParentDebris({ workDir, runner: fake.toRunner() });

    warnSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.skippedContentDiffers).toEqual([phantomFile]);
    expect(result.noCounterpart).toEqual([]);
    const warnLog = warnings.find(
      (l) => l.includes('[prune-stale-debris]') && l.includes('could not read local file'),
    );
    expect(warnLog).toBeDefined();
  });
});
