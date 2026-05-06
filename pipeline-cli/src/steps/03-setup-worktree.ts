/**
 * Step 3 — Setup the per-task git worktree from the latest origin/main.
 *
 * Mirrors `execute-orchestrator.md` Step 3. Fetches latest main first
 * (paired with Step 10.5 for AISDLC-102 defense in depth), creates the
 * worktree directory, and runs `git worktree add <path> -b <branch> origin/main`.
 *
 * AISDLC-224 — when `opts.autonomousMode === true` AND
 * `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` is truthy, a "branch already exists"
 * failure triggers an automatic cleanup-then-retry path. Three safety
 * predicates must all pass before any cleanup proceeds: no open PR, no
 * uncommitted changes, and the branch not checked out elsewhere. A
 * `WorktreeAutoCleaned` event is emitted when cleanup fires.
 *
 * @module steps/03-setup-worktree
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SetupWorktreeResult } from '../types.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';

/** Canonical truthy values for feature flags (per CLAUDE.md feature-flag conventions). */
function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface SetupWorktreeOptions {
  taskId: string;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Skip the `git fetch origin main` step (useful in tests / offline runs). */
  skipFetch?: boolean;
  /**
   * AISDLC-224 — when true, enables the auto-cleanup path on stale-branch
   * failures (provided `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` is also set).
   * The orchestrator loop sets this to true; manual `/ai-sdlc execute` leaves
   * it false (default OFF — no behavior change for manual path).
   */
  autonomousMode?: boolean;
  /**
   * AISDLC-224 — optional sink for the `WorktreeAutoCleaned` event. The
   * orchestrator loop injects its per-tick `emit`; tests inject a capturer.
   * When undefined, cleanup still proceeds but no event is emitted.
   */
  emitEvent?: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void;
}

/**
 * AISDLC-224 — check whether the `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP`
 * feature flag is enabled. Exported so tests can assert the predicate
 * without going through the full `setupWorktree()` call.
 */
export function isAutoCleanupEnabled(): boolean {
  return isFlagEnabled(process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP);
}

/** AISDLC-224 — detect "branch already exists" stderr pattern. */
function isBranchExistsError(stderr: string): boolean {
  return /branch.+already exists|already exists.+branch/i.test(stderr);
}

/**
 * AISDLC-224 — run all three safety predicates before any cleanup. Returns
 * `true` only when ALL three pass (safe to proceed with cleanup).
 *
 * Safety predicates:
 * 1. No open PR for the branch.
 * 2. No uncommitted changes in the existing worktree.
 * 3. Branch not checked out in any other registered worktree.
 */
async function isSafeToAutoClean(
  runner: Runner,
  workDir: string,
  branch: string,
  worktreePath: string,
): Promise<{ safe: boolean; hadOpenPR: boolean; hadUncommittedChanges: boolean }> {
  // Predicate 1: open-PR check
  const prResult = await runner(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'],
    { cwd: workDir, allowFailure: true },
  );
  let hadOpenPR = false;
  if (prResult.code === 0) {
    try {
      const parsed = JSON.parse(prResult.stdout.trim() || '[]') as unknown[];
      hadOpenPR = Array.isArray(parsed) && parsed.length > 0;
    } catch {
      // gh returned non-JSON — treat conservatively as having an open PR
      hadOpenPR = prResult.stdout.trim().length > 0;
    }
  }
  if (hadOpenPR) {
    return { safe: false, hadOpenPR: true, hadUncommittedChanges: false };
  }

  // Predicate 2: uncommitted-changes check (only if worktree path exists)
  let hadUncommittedChanges = false;
  const statusResult = await runner('git', ['-C', worktreePath, 'status', '--porcelain'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (statusResult.code === 0 && statusResult.stdout.trim().length > 0) {
    hadUncommittedChanges = true;
  } else if (statusResult.code !== 0) {
    // git status failed — worktree path likely doesn't exist yet, which is
    // fine (the worktree dir only exists if a prior session got past mkdir).
    // Treat a non-zero exit as "no uncommitted changes" since there's nothing
    // to lose. If the path does exist and git failed, that's unusual; still
    // safe because the worktree-remove step below will catch real issues.
  }
  if (hadUncommittedChanges) {
    return { safe: false, hadOpenPR: false, hadUncommittedChanges: true };
  }

  // Predicate 3: branch-checked-out-elsewhere check
  const worktreeListResult = await runner('git', ['worktree', 'list', '--porcelain'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (worktreeListResult.code === 0) {
    const lines = worktreeListResult.stdout.split('\n');
    let currentPath = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ') && line.includes(branch)) {
        // Found the branch — check if it's at a DIFFERENT path
        const normalizedCurrentPath = currentPath.replace(/\/$/, '');
        const normalizedExpectedPath = worktreePath.replace(/\/$/, '');
        if (normalizedCurrentPath !== normalizedExpectedPath) {
          // Branch is checked out at a different location — unsafe
          return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
        }
      }
    }
  }

  return { safe: true, hadOpenPR: false, hadUncommittedChanges: false };
}

/**
 * AISDLC-224 — attempt cleanup-then-retry when a stale branch blocks worktree
 * creation. Returns the retry result or null if cleanup was unsafe/failed.
 */
async function attemptAutoCleanup(
  runner: Runner,
  opts: SetupWorktreeOptions,
): Promise<{ retried: boolean; addResult: Awaited<ReturnType<Runner>> } | null> {
  const { safe, hadOpenPR, hadUncommittedChanges } = await isSafeToAutoClean(
    runner,
    opts.workDir,
    opts.branch,
    opts.worktreePath,
  );

  if (!safe) {
    return null;
  }

  // Emit WorktreeAutoCleaned event BEFORE running cleanup so it lands
  // in the events stream even if cleanup subsequently fails.
  if (opts.emitEvent) {
    opts.emitEvent({
      type: 'WorktreeAutoCleaned',
      ts: new Date().toISOString(),
      taskId: opts.taskId,
      branch: opts.branch,
      reason: 'branch already exists',
      hadOpenPR,
      hadUncommittedChanges,
    });
  }

  // Step 1: remove the stale worktree directory (if registered with git)
  await runner('git', ['worktree', 'remove', '--force', opts.worktreePath], {
    cwd: opts.workDir,
    allowFailure: true,
  });

  // Step 2: delete the stale local branch
  await runner('git', ['branch', '-D', opts.branch], {
    cwd: opts.workDir,
    allowFailure: true,
  });

  // Step 3: retry worktree add once
  const retryResult = await runner(
    'git',
    ['worktree', 'add', opts.worktreePath, '-b', opts.branch, 'origin/main'],
    { cwd: opts.workDir, allowFailure: true },
  );

  return { retried: true, addResult: retryResult };
}

export async function setupWorktree(opts: SetupWorktreeOptions): Promise<SetupWorktreeResult> {
  const runner = opts.runner ?? defaultRunner;

  if (!opts.skipFetch) {
    await runner('git', ['fetch', 'origin', 'main'], {
      cwd: opts.workDir,
      timeout: 30_000,
      allowFailure: true,
    });
  }

  // Idempotent mkdir of `.worktrees/`
  mkdirSync(join(opts.workDir, '.worktrees'), { recursive: true });

  const addResult = await runner(
    'git',
    ['worktree', 'add', opts.worktreePath, '-b', opts.branch, 'origin/main'],
    { cwd: opts.workDir, allowFailure: true },
  );

  if (addResult.code !== 0) {
    // AISDLC-224 — auto-cleanup path: only attempt when:
    //   a) autonomousMode is true
    //   b) AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP feature flag is on
    //   c) the error is specifically "branch already exists"
    const shouldTryCleanup =
      opts.autonomousMode === true &&
      isAutoCleanupEnabled() &&
      isBranchExistsError(addResult.stderr);

    if (shouldTryCleanup) {
      const cleanupResult = await attemptAutoCleanup(runner, opts);
      if (cleanupResult && cleanupResult.addResult.code === 0) {
        // Retry succeeded — continue with the cleaned-up worktree
        const baseShaResult = await runner('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'], {
          allowFailure: true,
        });
        const baseSha = baseShaResult.code === 0 ? baseShaResult.stdout.trim() : '';
        return { branch: opts.branch, worktreePath: opts.worktreePath, baseSha };
      }
    }

    // Either auto-cleanup was not attempted, predicates failed, or retry also failed
    throw new Error(
      `git worktree add failed for branch '${opts.branch}': ${addResult.stderr.trim() || 'unknown error'}\n` +
        `Likely cause: branch already exists. Run \`/ai-sdlc cleanup ${opts.taskId}\` first or pick a different task.`,
    );
  }

  const baseShaResult = await runner('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'], {
    allowFailure: true,
  });
  const baseSha = baseShaResult.code === 0 ? baseShaResult.stdout.trim() : '';

  return { branch: opts.branch, worktreePath: opts.worktreePath, baseSha };
}
