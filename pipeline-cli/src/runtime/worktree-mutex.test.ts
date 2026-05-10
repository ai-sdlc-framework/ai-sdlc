/**
 * Tests for the worktree mutex (AISDLC-241).
 *
 * AC #6: hermetic test — spawn 5 concurrent calls to the wrapped function
 *   with fake worktree-add commands; verify they execute sequentially
 *   (not interleaved) and all succeed.
 *
 * AC #7: integration test — real `git worktree add` against fixture repo,
 *   3 concurrent calls; assert no `.git/config.lock` errors.
 *
 * AC #4 + #5: lock released on error + timeout test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _globalMutex,
  _resetSignalHandlerFlag,
  isFileLockHeld,
  releaseFileLock,
  setupWorktreeSignalHandler,
  tryAcquireFileLock,
  withWorktreeMutex,
  type _MutexState,
} from './worktree-mutex.js';

// ── helpers ───────────────────────────────────────────────────────────────

function makeMutex(): _MutexState {
  return { queue: Promise.resolve(), depth: 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── AC #6 — hermetic sequencing test ─────────────────────────────────────

describe('withWorktreeMutex — in-process serialization (AC #6)', () => {
  it('runs 5 concurrent callers sequentially, all succeed, no interleaving', async () => {
    const mutex = makeMutex();
    const executionLog: string[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withWorktreeMutex(
        async () => {
          executionLog.push(`start-${i}`);
          // Simulate async work (e.g. git worktree add latency).
          await delay(5);
          executionLog.push(`end-${i}`);
        },
        { _mutex: mutex },
      ),
    );

    await Promise.all(tasks);

    // Every start-N must be immediately followed by end-N with no other
    // task's start in between (i.e. tasks ran sequentially).
    for (let i = 0; i < 5; i++) {
      const startIdx = executionLog.indexOf(`start-${i}`);
      const endIdx = executionLog.indexOf(`end-${i}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBe(startIdx + 1);
    }

    // All 10 entries present.
    expect(executionLog).toHaveLength(10);
  });

  it('mutex depth returns to 0 after all callers finish', async () => {
    const mutex = makeMutex();
    const tasks = Array.from({ length: 3 }, () =>
      withWorktreeMutex(async () => delay(1), { _mutex: mutex }),
    );
    await Promise.all(tasks);
    expect(mutex.depth).toBe(0);
  });
});

// ── AC #4 — lock released on error ───────────────────────────────────────

describe('withWorktreeMutex — release on error (AC #4)', () => {
  it('releases the mutex even when fn throws', async () => {
    const mutex = makeMutex();

    await expect(
      withWorktreeMutex(
        async () => {
          throw new Error('critical section failure');
        },
        { _mutex: mutex },
      ),
    ).rejects.toThrow('critical section failure');

    // Depth must be 0 — the lock was released.
    expect(mutex.depth).toBe(0);

    // Subsequent callers must not hang.
    const result = await withWorktreeMutex(async () => 'recovered', { _mutex: mutex });
    expect(result).toBe('recovered');
  });

  it('serializes correctly when interleaved with errors', async () => {
    const mutex = makeMutex();
    const log: string[] = [];

    const tasks = [
      withWorktreeMutex(
        async () => {
          log.push('t1-start');
          await delay(5);
          log.push('t1-end');
          throw new Error('t1 error');
        },
        { _mutex: mutex },
      ).catch(() => {
        log.push('t1-caught');
      }),
      withWorktreeMutex(
        async () => {
          log.push('t2-start');
          await delay(5);
          log.push('t2-end');
        },
        { _mutex: mutex },
      ),
    ];

    await Promise.all(tasks);

    // t1 completes (start→end) before t2 starts.
    expect(log[0]).toBe('t1-start');
    expect(log[1]).toBe('t1-end');
    // t1-caught fires after t1 ends (caller promise settled).
    // t2 starts only after t1's lock slot is released.
    expect(log).toContain('t2-start');
    expect(log).toContain('t2-end');
    const t2StartIdx = log.indexOf('t2-start');
    const t1EndIdx = log.indexOf('t1-end');
    expect(t2StartIdx).toBeGreaterThan(t1EndIdx);
  });
});

// ── AC #5 — timeout ───────────────────────────────────────────────────────

describe('withWorktreeMutex — timeout (AC #5)', () => {
  it('throws the descriptive timeout message when held longer than timeoutMs', async () => {
    const mutex = makeMutex();

    // First caller acquires the lock and holds it indefinitely (resolved
    // via a manual trigger after the second caller times out).
    let releaseLongHolder!: () => void;
    const longHolderReleased = new Promise<void>((res) => {
      releaseLongHolder = res;
    });

    // Start long holder in background.
    const longHolder = withWorktreeMutex(() => longHolderReleased, { _mutex: mutex });

    // Second caller should time out quickly.
    await expect(
      withWorktreeMutex(async () => 'should not run', { _mutex: mutex, timeoutMs: 50 }),
    ).rejects.toThrow(/worktree mutex held > 60s/);

    // Now release the long holder so the test can clean up.
    releaseLongHolder();
    await longHolder;

    expect(mutex.depth).toBe(0);
  });

  it('a timed-out waiter does not block subsequent callers', async () => {
    const mutex = makeMutex();
    const log: string[] = [];

    let releaseHolder!: () => void;
    const holderDone = new Promise<void>((res) => {
      releaseHolder = res;
    });

    // Caller 1: hold forever.
    const holder = withWorktreeMutex(() => holderDone, { _mutex: mutex });

    // Caller 2: times out.
    await expect(
      withWorktreeMutex(async () => void log.push('c2-ran'), { _mutex: mutex, timeoutMs: 30 }),
    ).rejects.toThrow(/worktree mutex held > 60s/);

    // Caller 3: enqueues AFTER the timeout.
    const c3 = withWorktreeMutex(
      async () => {
        log.push('c3-ran');
      },
      { _mutex: mutex },
    );

    // Release the holder; c3 should now run.
    releaseHolder();
    await Promise.all([holder, c3]);

    expect(log).not.toContain('c2-ran');
    expect(log).toContain('c3-ran');
    expect(mutex.depth).toBe(0);
  });

  // AISDLC-241 — Bug 2 regression test: queue-chain break on timeout.
  //
  // Failure scenario prior to fix:
  //   C1 holds the mutex → C2 enqueues with a short timeout → C2 times out
  //   and EAGERLY resolves its own `newTail` → C3 enqueues; its `prevTail`
  //   is already-resolved C2.newTail → C3 enters the critical section
  //   CONCURRENTLY with C1. This breaks the mutual-exclusion guarantee.
  //
  // After the fix: on timeout, C2 chains `prevTail.finally(() => releaseLock())`
  // so C2.newTail only resolves after C1 releases, preserving the queue order.
  it('AISDLC-241: C3 enqueued after C2 timeout does NOT start before C1 finishes', async () => {
    const mutex = makeMutex();

    let c1ReleaseFn!: () => void;
    let c1EndTime = 0;
    let c3StartTime = 0;

    const c1Done = new Promise<void>((res) => {
      c1ReleaseFn = res;
    });

    // C1: acquires + holds for ~100ms.
    const c1 = withWorktreeMutex(
      async () => {
        await c1Done;
        c1EndTime = Date.now();
      },
      { _mutex: mutex },
    );

    // C2: enqueues with a short timeout (25ms) — will time out while C1 holds.
    const c2Timeout = withWorktreeMutex(async () => {}, { _mutex: mutex, timeoutMs: 25 });

    // Let C2 time out.
    await expect(c2Timeout).rejects.toThrow(/worktree mutex held > 60s/);

    // t=30ms: C3 enqueues AFTER C2 has already timed out.
    await delay(5); // brief pause to ensure C2's timeout settled
    const c3 = withWorktreeMutex(
      async () => {
        c3StartTime = Date.now();
      },
      { _mutex: mutex },
    );

    // Now release C1 (simulate the real holder finishing after ~100ms total).
    await delay(50); // simulate remaining hold time
    c1ReleaseFn();
    await Promise.all([c1, c3]);

    // CRITICAL assertion: C3 must NOT have started before C1 ended.
    // If the bug is present, c3StartTime < c1EndTime because C3 entered
    // the critical section while C1 was still running.
    expect(c3StartTime).toBeGreaterThanOrEqual(c1EndTime);
    expect(mutex.depth).toBe(0);
  });
});

// ── File lock tests ───────────────────────────────────────────────────────

describe('file lock helpers', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-mutex-test-'));
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tryAcquireFileLock returns true on first acquire', () => {
    expect(tryAcquireFileLock(tmpDir)).toBe(true);
    expect(isFileLockHeld(tmpDir)).toBe(true);
  });

  it('tryAcquireFileLock returns false when already held', () => {
    tryAcquireFileLock(tmpDir);
    expect(tryAcquireFileLock(tmpDir)).toBe(false);
  });

  it('releaseFileLock removes the lock directory', () => {
    tryAcquireFileLock(tmpDir);
    releaseFileLock(tmpDir);
    expect(isFileLockHeld(tmpDir)).toBe(false);
  });

  it('releaseFileLock is idempotent when not held', () => {
    expect(() => releaseFileLock(tmpDir)).not.toThrow();
  });
});

// ── withWorktreeMutex with file lock ─────────────────────────────────────

describe('withWorktreeMutex — file lock integration', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-mutex-file-test-'));
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
  });
  afterEach(() => {
    releaseFileLock(tmpDir); // ensure cleanup even if test fails
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases the file lock around fn', async () => {
    const mutex = makeMutex();
    let heldDuring = false;

    await withWorktreeMutex(
      async () => {
        heldDuring = isFileLockHeld(tmpDir);
      },
      { _mutex: mutex, workDir: tmpDir },
    );

    expect(heldDuring).toBe(true);
    expect(isFileLockHeld(tmpDir)).toBe(false);
  });

  it('releases the file lock on error', async () => {
    const mutex = makeMutex();

    await expect(
      withWorktreeMutex(
        async () => {
          throw new Error('boom');
        },
        { _mutex: mutex, workDir: tmpDir },
      ),
    ).rejects.toThrow('boom');

    expect(isFileLockHeld(tmpDir)).toBe(false);
  });
});

// ── setupWorktreeSignalHandler ────────────────────────────────────────────

describe('setupWorktreeSignalHandler', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-mutex-signal-test-'));
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    _resetSignalHandlerFlag();
  });
  afterEach(() => {
    releaseFileLock(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    _resetSignalHandlerFlag();
  });

  it('installs without error', () => {
    expect(() => setupWorktreeSignalHandler(tmpDir)).not.toThrow();
  });

  it('is idempotent (safe to call multiple times)', () => {
    setupWorktreeSignalHandler(tmpDir);
    // Second call should not throw or duplicate handlers.
    expect(() => setupWorktreeSignalHandler(tmpDir)).not.toThrow();
  });
});

// ── AC #7 — integration test with real git repo ───────────────────────────

/**
 * Hermetic env for AC #7 real-git execSync calls.
 *
 * Env-hygiene pattern (AISDLC-246): all execSync calls that shell out to git
 * inside a tmpdir fixture MUST use an explicit, sanitised env rather than
 * inheriting `process.env`. The parent shell can export vars that silently
 * redirect or corrupt git operations in the child process:
 *
 *   GIT_DIR / GIT_WORK_TREE   — redirect git's repo/worktree pointers away
 *                                from the tmpdir, causing operations to land
 *                                in the calling project's .git instead.
 *   GIT_INDEX_FILE             — similarly hijacks the index.
 *   GIT_CONFIG_GLOBAL /
 *   GIT_CONFIG_SYSTEM          — can inject gpgsign=true or custom hooks
 *                                that break `git commit` in the fixture.
 *   CLAUDE_PROJECT_DIR /
 *   GIT_ASKPASS / GIT_EDITOR   — set by the IDE / Claude Code; harmless for
 *                                normal git ops but can cause unexpected
 *                                subprocess spawning or auth-prompt hangs.
 *   HUSKY                      — controls husky hook execution; without this
 *                                git commit will run the calling project's
 *                                .husky/pre-commit lint-staged + typecheck,
 *                                which fails inside an isolated tmpdir.
 *
 * The safe subset passed below is:
 *   PATH   — required to find git, bash, etc.
 *   HOME   — required for git fallback identity lookup (mitigated by
 *             GIT_AUTHOR_{NAME,EMAIL} overrides below, but some git versions
 *             still read HOME for SSH config even when identity is overridden).
 *   TMPDIR / TEMP / TMP — OS temp directory (macOS/Linux/Windows).
 *   LANG / LC_ALL       — prevent git from emitting locale-specific
 *                         error strings that break stderr parsing.
 *
 * Identity is provided via GIT_AUTHOR_{NAME,EMAIL} / GIT_COMMITTER_{NAME,EMAIL}
 * env vars so that we never have to run `git config user.email` — which would
 * write into the fixture's .git/config and could be redirected by GIT_DIR bleed.
 *
 * System and global git config is disabled via GIT_CONFIG_NOSYSTEM=1 and
 * GIT_CONFIG_GLOBAL=/dev/null so that operator-level gpgsign or hook
 * settings cannot bleed into the fixture.
 *
 * Husky is explicitly disabled via HUSKY=0 so that git commit in the
 * fixture does not attempt to run the calling project's pre-commit hooks.
 *
 * core.hooksPath is additionally set to /dev/null via `-c` in the commit
 * invocation as a belt-and-suspenders guard against any hookPath config
 * that survived the env sanitisation above.
 */
function makeGitEnv(): NodeJS.ProcessEnv {
  return {
    // Minimal OS plumbing.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    ...(process.env['TEMP'] ? { TEMP: process.env['TEMP'] } : {}),
    ...(process.env['TMP'] ? { TMP: process.env['TMP'] } : {}),
    // Locale — prevent non-ASCII error strings in git output.
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    LC_ALL: 'C',
    // Git identity — supplied via env so git config writes are unnecessary.
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
    // Disable system + global git config to prevent gpgsign/hook bleed.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Disable husky so the calling project's pre-commit hooks don't fire.
    HUSKY: '0',
    // Suppress credential helpers / interactive prompts.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  };
}

describe('withWorktreeMutex — real git worktree add (AC #7)', () => {
  let repoDir: string;
  let worktreeDirs: string[];
  let gitEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'worktree-mutex-integration-'));
    worktreeDirs = [];
    gitEnv = makeGitEnv();

    // Initialise a real git repo with a commit on main.
    //
    // Env-hygiene: all execSync calls use an explicit hermetic env (gitEnv)
    // to prevent parent-shell GIT_DIR / GIT_WORK_TREE / CLAUDE_PROJECT_DIR /
    // HUSKY bleed. Identity is passed via GIT_AUTHOR_* env vars so we never
    // need `git config user.email`, which would write into .git/config and
    // could be redirected if GIT_DIR is set in the parent env.
    //
    // Additionally, `-c core.hooksPath=/dev/null` prevents any hookPath that
    // survived env sanitisation from running on `git commit`.
    execSync('git init -b main', { cwd: repoDir, env: gitEnv, stdio: 'pipe' });
    execSync('touch README.md && git add .', {
      cwd: repoDir,
      env: gitEnv,
      shell: '/bin/bash',
      stdio: 'pipe',
    });
    execSync('git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -m "init"', {
      cwd: repoDir,
      env: gitEnv,
      stdio: 'pipe',
    });
  });

  afterEach(() => {
    // Prune all registered worktrees before removing directories.
    try {
      execSync('git worktree prune', { cwd: repoDir, env: gitEnv, stdio: 'pipe' });
    } catch {
      // best-effort
    }
    for (const wt of worktreeDirs) {
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('3 concurrent git worktree add calls succeed with no .git/config.lock collision', async () => {
    const mutex = makeMutex();
    const errors: Error[] = [];

    const branches = ['feature-a', 'feature-b', 'feature-c'];
    const tasks = branches.map((branch) => {
      const wtPath = join(repoDir, `.worktrees`, branch);
      worktreeDirs.push(wtPath);
      return withWorktreeMutex(
        async () => {
          // Run the real git worktree add with the hermetic env.
          execSync(`git worktree add "${wtPath}" -b "${branch}" HEAD`, {
            cwd: repoDir,
            env: gitEnv,
            stdio: 'pipe',
          });
        },
        { _mutex: mutex, workDir: repoDir },
      ).catch((err: Error) => {
        errors.push(err);
      });
    });

    await Promise.all(tasks);

    // All three worktrees must have been created successfully.
    expect(errors, `unexpected errors: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    for (const branch of branches) {
      const wtPath = join(repoDir, '.worktrees', branch);
      expect(existsSync(wtPath)).toBe(true);
    }

    // No .git/config.lock should remain.
    expect(existsSync(join(repoDir, '.git', 'config.lock'))).toBe(false);
  });
});
