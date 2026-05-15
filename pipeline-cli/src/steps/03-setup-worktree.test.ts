import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupWorktree } from './03-setup-worktree.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import { join } from 'node:path';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import type { ExecResult } from '../runtime/exec.js';

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

// ── AISDLC-224 — auto-cleanup tests ───────────────────────────────────

describe('Step 3 — setupWorktree auto-cleanup (AISDLC-224)', () => {
  const BRANCH_EXISTS_STDERR = "fatal: a branch named 'ai-sdlc/aisdlc-99' already exists";
  const BRANCH = 'ai-sdlc/aisdlc-99';
  const TASK_ID = 'AISDLC-99';

  function makeWorktreePath(): string {
    return join(tmp, '.worktrees', 'aisdlc-99');
  }

  /**
   * AC #5 — Positive: stale branch + no open PR + clean working tree +
   * flag=on → cleanup succeeds, retry succeeds, WorktreeAutoCleaned event present.
   */
  it('auto-cleans stale branch, retries, and emits WorktreeAutoCleaned when all predicates pass', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        // Initial fetch
        .on(/^git fetch origin main/, ok())
        // First worktree add fails with "branch already exists"
        .on(
          (cmd, args) =>
            cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args.length > 4,
          (() => {
            let call = 0;
            return () => {
              call++;
              if (call === 1) return fail(BRANCH_EXISTS_STDERR, 128);
              return ok(); // retry succeeds
            };
          })(),
        )
        // gh pr list returns empty array (no open PRs)
        .on(/^gh pr list/, ok('[]\n'))
        // git status --porcelain returns empty (clean)
        .on(/^git -C .+ status --porcelain/, ok(''))
        // git worktree list --porcelain — branch not listed elsewhere
        .on(
          /^git worktree list --porcelain/,
          ok('worktree /some/other/path\nbranch refs/heads/other-branch\n\n'),
        )
        // git worktree remove --force
        .on(/^git worktree remove --force/, ok())
        // git branch -D
        .on(/^git branch -D/, ok())
        // Final rev-parse HEAD after successful retry
        .on(/^git -C .+ rev-parse HEAD/, ok('deadbeef\n'));

      const result = await setupWorktree({
        taskId: TASK_ID,
        branch: BRANCH,
        worktreePath: makeWorktreePath(),
        workDir: tmp,
        runner: fake.toRunner(),
        autonomousMode: true,
        skipFetch: false,
        emitEvent: (ev) => {
          emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
        },
      });

      // Verify result
      expect(result.branch).toBe(BRANCH);
      expect(result.baseSha).toBe('deadbeef');

      // Verify WorktreeAutoCleaned event was emitted
      const cleanedEvent = emitted.find((e) => e.type === 'WorktreeAutoCleaned');
      expect(cleanedEvent).toBeDefined();
      expect(cleanedEvent?.taskId).toBe(TASK_ID);
      expect(cleanedEvent?.branch).toBe(BRANCH);
      expect(cleanedEvent?.reason).toBe('branch already exists');
      expect(cleanedEvent?.hadOpenPR).toBe(false);
      expect(cleanedEvent?.hadUncommittedChanges).toBe(false);

      // Verify cleanup commands were called
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall).toBeDefined();

      const worktreeRemoveCall = fake.calls.find(
        (c) =>
          c.command === 'git' &&
          c.args[0] === 'worktree' &&
          c.args[1] === 'remove' &&
          c.args[2] === '--force',
      );
      expect(worktreeRemoveCall).toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * AC #6 — Negative: stale branch + open PR → cleanup refuses, original
   * error returned, no WorktreeAutoCleaned event.
   */
  it('refuses cleanup when an open PR exists, returns original error', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Initial worktree add fails
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // gh pr list returns an open PR
        .on(/^gh pr list/, ok('[{"number":42}]\n'));

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // No cleanup event should be emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      // Cleanup commands should NOT have been called
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * AC #7 — Negative: stale branch + uncommitted changes → cleanup refuses,
   * original error returned, no WorktreeAutoCleaned event.
   */
  it('refuses cleanup when uncommitted changes exist in the worktree, returns original error', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Initial worktree add fails
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // No open PRs
        .on(/^gh pr list/, ok('[]\n'))
        // git status returns uncommitted changes
        .on(/^git -C .+ status --porcelain/, ok(' M some-file.ts\n'));

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // No cleanup event should be emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      // Cleanup commands should NOT have been called
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * AC #3 — Negative: flag=off → cleanup never runs even with stale branch +
   * clean state + autonomousMode=true.
   */
  it('skips auto-cleanup when AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP is not set', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Worktree add fails with branch-exists
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        );

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true, // flag is on, but env var is off
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // No cleanup event should be emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      // No gh pr list, no git status, no cleanup commands
      const ghCall = fake.calls.find((c) => c.command === 'gh');
      expect(ghCall).toBeUndefined();

      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * AC #1/#3 — Negative: autonomousMode=false (or unset) → cleanup never runs
   * even when flag is on.
   */
  it('skips auto-cleanup when autonomousMode is false even with flag enabled', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Worktree add fails with branch-exists
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        );

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          // autonomousMode not set (defaults to false/undefined)
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // No cleanup event should be emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      // No gh pr list calls — safety predicates were never evaluated
      const ghCall = fake.calls.find((c) => c.command === 'gh');
      expect(ghCall).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * Code-reviewer #377 finding 1 — Predicate 1 must FAIL CLOSED on `gh` errors.
   * If `gh pr list` exits non-zero (token expired, network timeout, gh not
   * installed), cleanup must NOT proceed. Without this, a transient gh
   * failure would let `git branch -D` delete a branch backing a live PR.
   */
  it('refuses cleanup when gh pr list fails (fail closed, not fail open)', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Worktree add fails with branch-exists
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // gh pr list fails with auth error
        .on(/^gh pr list/, fail('error: not authenticated. run `gh auth login`', 1));

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // Cleanup must NOT have run (fail-closed)
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'gh failure must NOT trigger branch delete').toBeUndefined();

      // No event emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * Code-reviewer #377 finding 6 — retry-also-fails path. If cleanup runs
   * but the second `git worktree add` ALSO fails, original error must be
   * thrown, no infinite loop, and no `WorktreeAutoCleaned` event emitted
   * (because cleanup didn't actually finish — the retry-success post-emit
   * order ensures this).
   */
  it('throws original error and does NOT emit event when retry also fails', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];
      let worktreeAddCallCount = 0;

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Both first AND second worktree add fail
        .on(
          (cmd, args) =>
            cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args.length > 4,
          () => {
            worktreeAddCallCount++;
            return fail(BRANCH_EXISTS_STDERR, 128);
          },
        )
        .on(/^gh pr list/, ok('[]\n'))
        .on(/^git -C .+ status --porcelain/, ok(''))
        .on(/^git worktree list --porcelain/, ok(''))
        .on(/^git worktree remove --force/, ok())
        .on(/^git branch -D/, ok());

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // Exactly 2 worktree-add calls — original + one retry, no infinite loop
      expect(worktreeAddCallCount).toBe(2);

      // NO event emitted because retry didn't succeed
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * Code-reviewer #377 finding 3 — Predicate 3 must use EXACT match on the
   * `branch refs/heads/<name>` line, not `includes()`. Branch `ai-sdlc/aisdlc-9`
   * must NOT match a worktree-list line `branch refs/heads/ai-sdlc/aisdlc-99`.
   */
  it('predicate-3 does NOT false-positive on branch name prefixes', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      // Use a branch whose name is a PREFIX of a longer branch name in the
      // worktree list. With `includes()`, the longer branch's worktree
      // line would match and falsely block cleanup.
      const SHORT_BRANCH = 'ai-sdlc/aisdlc-9';

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) =>
            cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args.length > 4,
          (() => {
            let call = 0;
            return () => {
              call++;
              if (call === 1) return fail(BRANCH_EXISTS_STDERR, 128);
              return ok();
            };
          })(),
        )
        .on(/^gh pr list/, ok('[]\n'))
        .on(/^git -C .+ status --porcelain/, ok(''))
        // Worktree list contains AISDLC-99 but NOT the short branch we're
        // checking. Old `includes()` impl would match because the short
        // branch is a prefix of the longer one.
        .on(
          /^git worktree list --porcelain/,
          ok('worktree /elsewhere\nbranch refs/heads/ai-sdlc/aisdlc-99\n\n'),
        )
        .on(/^git worktree remove --force/, ok())
        .on(/^git branch -D/, ok())
        .on(/^git -C .+ rev-parse HEAD/, ok('cafebabe\n'));

      const result = await setupWorktree({
        taskId: 'AISDLC-9',
        branch: SHORT_BRANCH,
        worktreePath: makeWorktreePath(),
        workDir: tmp,
        runner: fake.toRunner(),
        autonomousMode: true,
      });

      // Cleanup proceeded (the prefix-match false positive is fixed)
      expect(result.branch).toBe(SHORT_BRANCH);
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'cleanup must run when branch is only a name prefix').toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });
});

// ── AISDLC-228 — new safety predicates (signals 4-6) ─────────────────────────

describe('Step 3 — isSafeToAutoClean AISDLC-228 signals', () => {
  const BRANCH_EXISTS_STDERR = "fatal: a branch named 'ai-sdlc/aisdlc-99' already exists";
  const BRANCH = 'ai-sdlc/aisdlc-99';
  const TASK_ID = 'AISDLC-99';

  function makeWorktreePath(): string {
    return join(tmp, '.worktrees', 'aisdlc-99');
  }

  /**
   * Signal 4 — unpushed commits (no upstream): cleanup must refuse when the
   * branch has commits ahead of origin/main and no remote upstream.
   */
  it('refuses cleanup when branch has unpushed commits and no remote upstream', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        // Initial worktree add fails with branch-exists
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // No open PRs (signal 1 quiet)
        .on(/^gh pr list/, ok('[]\n'))
        // git status: clean (signal 2 quiet)
        .on(/^git -C .+ status --porcelain/, ok(''))
        // git worktree list: not checked out elsewhere (signal 3 quiet)
        .on(/^git worktree list --porcelain/, ok('worktree /some/path\nbranch refs/heads/other\n'))
        // Signal 4: no upstream → non-zero
        .on(/^git rev-parse --abbrev-ref ai-sdlc\/aisdlc-99@{upstream}/, fail('no upstream', 128))
        // Signal 4: commits ahead of origin/main
        .on(/^git rev-list --count ai-sdlc\/aisdlc-99 \^origin\/main/, ok('2\n'));

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
          readSentinelMtime: () => null, // no sentinel (signal 5 quiet)
          readProcessTable: () => '', // no subprocess (signal 6 quiet)
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // No cleanup event emitted
      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      // No branch -D call
      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'must not delete branch with unpushed commits').toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * Signal 5 — active sentinel (<6h): cleanup must refuse when the .active-task
   * sentinel was modified within the last 6 hours.
   */
  it('refuses cleanup when the .active-task sentinel is younger than 6 hours', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    const nowMs = 1_700_000_000_000;
    const tenMinutesAgo = nowMs - 10 * 60 * 1000;
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // Signals 1-3 quiet
        .on(/^gh pr list/, ok('[]\n'))
        .on(/^git -C .+ status --porcelain/, ok(''))
        .on(/^git worktree list --porcelain/, ok('worktree /some/path\nbranch refs/heads/other\n'))
        // Signal 4: has upstream, not ahead of it
        .on(
          /^git rev-parse --abbrev-ref ai-sdlc\/aisdlc-99@{upstream}/,
          ok('origin/ai-sdlc/aisdlc-99\n'),
        )
        .on(/^git rev-list --count ai-sdlc\/aisdlc-99 \^origin\/ai-sdlc\/aisdlc-99/, ok('0\n'));

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
          readSentinelMtime: () => tenMinutesAgo, // fresh sentinel → signal 5 fires
          readProcessTable: () => '', // signal 6 quiet
          nowMs: () => nowMs,
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'must not delete branch with active sentinel').toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * Signal 6 — live claude --print subprocess: cleanup must refuse when the
   * process table shows a claude subprocess for this task.
   */
  it('refuses cleanup when a live claude --print subprocess is running for this task', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(BRANCH_EXISTS_STDERR, 128),
        )
        // Signals 1-3 quiet
        .on(/^gh pr list/, ok('[]\n'))
        .on(/^git -C .+ status --porcelain/, ok(''))
        .on(/^git worktree list --porcelain/, ok('worktree /some/path\nbranch refs/heads/other\n'))
        // Signal 4: has upstream, not ahead
        .on(
          /^git rev-parse --abbrev-ref ai-sdlc\/aisdlc-99@{upstream}/,
          ok('origin/ai-sdlc/aisdlc-99\n'),
        )
        .on(/^git rev-list --count ai-sdlc\/aisdlc-99 \^origin\/ai-sdlc\/aisdlc-99/, ok('0\n'));

      const fakePs = [
        '    1 /sbin/launchd',
        '55555 /usr/local/bin/claude --print AISDLC-99 some-developer-prompt',
      ].join('\n');

      await expect(
        setupWorktree({
          taskId: TASK_ID,
          branch: BRANCH,
          worktreePath: makeWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
          emitEvent: (ev) => {
            emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
          },
          readSentinelMtime: () => null, // signal 5 quiet
          readProcessTable: () => fakePs, // signal 6 fires
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      expect(emitted.find((e) => e.type === 'WorktreeAutoCleaned')).toBeUndefined();

      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'must not delete branch with live subprocess').toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  /**
   * AC #7 — no regression: all 6 signals quiet → cleanup proceeds normally.
   * Signals 1-3 are from AISDLC-224, signals 4-6 from AISDLC-228.
   */
  it('AC#7 — cleans up when ALL 6 signals say stale (truly stale branch)', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    const nowMs = 1_700_000_000_000;
    const eightHoursAgo = nowMs - 8 * 60 * 60 * 1000;
    try {
      const emitted: OrchestratorEvent[] = [];

      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) =>
            cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args.length > 4,
          (() => {
            let call = 0;
            return (): ExecResult => {
              call++;
              if (call === 1) return fail(BRANCH_EXISTS_STDERR, 128);
              return ok();
            };
          })(),
        )
        // Signal 1: no open PR
        .on(/^gh pr list/, ok('[]\n'))
        // Signal 2: clean worktree
        .on(/^git -C .+ status --porcelain/, ok(''))
        // Signal 3: not checked out elsewhere
        .on(/^git worktree list --porcelain/, ok('worktree /somewhere\nbranch refs/heads/other\n'))
        // Signal 4: has upstream, NOT ahead of it
        .on(
          /^git rev-parse --abbrev-ref ai-sdlc\/aisdlc-99@{upstream}/,
          ok('origin/ai-sdlc/aisdlc-99\n'),
        )
        .on(/^git rev-list --count ai-sdlc\/aisdlc-99 \^origin\/ai-sdlc\/aisdlc-99/, ok('0\n'))
        // Cleanup commands
        .on(/^git worktree remove --force/, ok())
        .on(/^git branch -D/, ok())
        // Final rev-parse after retry
        .on(/^git -C .+ rev-parse HEAD/, ok('deadbeef\n'));

      const result = await setupWorktree({
        taskId: TASK_ID,
        branch: BRANCH,
        worktreePath: makeWorktreePath(),
        workDir: tmp,
        runner: fake.toRunner(),
        autonomousMode: true,
        emitEvent: (ev) => {
          emitted.push({ ts: new Date().toISOString(), ...ev } as OrchestratorEvent);
        },
        readSentinelMtime: () => eightHoursAgo, // signal 5: old sentinel (>6h) → quiet
        readProcessTable: () => '', // signal 6: no subprocess → quiet
        nowMs: () => nowMs,
      });

      // Cleanup must have proceeded
      expect(result.branch).toBe(BRANCH);
      expect(result.baseSha).toBe('deadbeef');

      const cleanedEvent = emitted.find((e) => e.type === 'WorktreeAutoCleaned');
      expect(cleanedEvent).toBeDefined();

      const branchDeleteCall = fake.calls.find(
        (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D',
      );
      expect(branchDeleteCall, 'cleanup must run when all signals are quiet').toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });
});

/**
 * AISDLC-273 — isSafeToAutoClean draft-PR differentiation.
 *
 * When the only open PR for the branch is DRAFT, the predicate still refuses
 * cleanup (auto-cleanup behaviour is unchanged), but it surfaces a richer
 * `hadDraftPR` signal so the caller can suggest `--resume-from-draft`.
 *
 * Round-1 test review (PR #489) flagged the new isDraft branch as untested:
 * existing open-PR tests pass `[{"number":42}]` (no isDraft field) so the
 * `parsed.every((pr) => pr.isDraft === true)` branch never fires.
 */
describe('Step 3 — isSafeToAutoClean draft-PR differentiation (AISDLC-273)', () => {
  const STDERR_BRANCH_EXISTS = "fatal: a branch named 'ai-sdlc/aisdlc-99' already exists";
  const LOCAL_BRANCH = 'ai-sdlc/aisdlc-99';
  const LOCAL_TASK_ID = 'AISDLC-99';
  const localWorktreePath = (): string => join(tmp, '.worktrees', 'aisdlc-99');

  it('refuses cleanup AND logs "draft PR" kind when the only open PR is draft', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(STDERR_BRANCH_EXISTS, 128),
        )
        .on(/^gh pr list/, ok('[{"number":42,"isDraft":true}]\n'));

      await expect(
        setupWorktree({
          taskId: LOCAL_TASK_ID,
          branch: LOCAL_BRANCH,
          worktreePath: localWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      // The "kind = hadDraftPR ? 'draft PR' : 'ready PR'" branch must have
      // selected 'draft PR' for an isDraft:true payload.
      const drafLog = consoleSpy.mock.calls.find((c) => String(c[0] ?? '').includes('draft PR'));
      expect(drafLog, 'console.info must log "draft PR" kind').toBeDefined();
      const readyLog = consoleSpy.mock.calls.find((c) => String(c[0] ?? '').includes('ready PR'));
      expect(
        readyLog,
        'console.info must NOT log "ready PR" for an isDraft:true payload',
      ).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });

  it('logs "ready PR" kind when the open PR is NOT draft', async () => {
    const originalEnv = process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
    process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = '1';
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fake = new FakeRunner()
        .on(/^git fetch origin main/, ok())
        .on(
          (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
          fail(STDERR_BRANCH_EXISTS, 128),
        )
        .on(/^gh pr list/, ok('[{"number":42,"isDraft":false}]\n'));

      await expect(
        setupWorktree({
          taskId: LOCAL_TASK_ID,
          branch: LOCAL_BRANCH,
          worktreePath: localWorktreePath(),
          workDir: tmp,
          runner: fake.toRunner(),
          autonomousMode: true,
        }),
      ).rejects.toThrow(/branch already exists|cleanup AISDLC-99/);

      const readyLog = consoleSpy.mock.calls.find((c) => String(c[0] ?? '').includes('ready PR'));
      expect(readyLog, 'console.info must log "ready PR" kind').toBeDefined();
    } finally {
      consoleSpy.mockRestore();
      if (originalEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP = originalEnv;
      }
    }
  });
});
