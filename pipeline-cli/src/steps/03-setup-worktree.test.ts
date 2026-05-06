import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupWorktree } from './03-setup-worktree.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import { join } from 'node:path';
import type { OrchestratorEvent } from '../orchestrator/events.js';

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
});
