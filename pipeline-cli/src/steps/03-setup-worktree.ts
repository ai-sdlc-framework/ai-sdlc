/**
 * Step 3 — Setup the per-task git worktree from the latest origin/main.
 *
 * Mirrors `execute-orchestrator.md` Step 3. Fetches latest main first
 * (paired with Step 10.5 for AISDLC-102 defense in depth), creates the
 * worktree directory, and runs `git worktree add <path> -b <branch> origin/main`.
 *
 * @module steps/03-setup-worktree
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SetupWorktreeResult } from '../types.js';

export interface SetupWorktreeOptions {
  taskId: string;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Skip the `git fetch origin main` step (useful in tests / offline runs). */
  skipFetch?: boolean;
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
