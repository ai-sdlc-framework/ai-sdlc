/**
 * Step 0 — Sweep merged worktrees.
 *
 * Mirrors `ai-sdlc-plugin/agents/execute-orchestrator.md` Step 0. Walks
 * `<workDir>/.worktrees/`, looks up each worktree's branch, and removes
 * the worktree if the corresponding GitHub PR has merged.
 *
 * Pure with respect to its inputs — accepts a `Runner` so tests can stub
 * `git` / `gh` invocations without any side effects.
 *
 * Idempotent and parallel-safe: `git worktree remove --force` on an
 * already-swept entry is a no-op.
 *
 * @module steps/00-sweep
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SweepResult } from '../types.js';

export interface SweepOptions {
  workDir: string;
  runner?: Runner;
}

export async function sweepMergedWorktrees(opts: SweepOptions): Promise<SweepResult> {
  const runner = opts.runner ?? defaultRunner;
  const worktreesDir = join(opts.workDir, '.worktrees');

  if (!existsSync(worktreesDir)) {
    return { swept: [] };
  }

  const swept: SweepResult['swept'] = [];

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return { swept: [] };
  }

  for (const entry of entries) {
    const wt = join(worktreesDir, entry);
    let isDir = false;
    try {
      isDir = statSync(wt).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    let branch: string;
    try {
      const r = await runner('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        allowFailure: true,
      });
      if (r.code !== 0) continue;
      branch = r.stdout.trim();
    } catch {
      continue;
    }

    if (!branch || branch === 'HEAD') continue; // detached, skip

    let mergedAt = '';
    try {
      const r = await runner(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branch,
          '--state',
          'merged',
          '--json',
          'mergedAt',
          '--jq',
          '.[0].mergedAt',
        ],
        { allowFailure: true, cwd: opts.workDir },
      );
      if (r.code === 0) mergedAt = r.stdout.trim();
    } catch {
      // network/auth failure — skip silently per RFC contract
      continue;
    }

    if (!mergedAt || mergedAt === 'null') continue;

    try {
      await runner('git', ['worktree', 'remove', '--force', wt], {
        cwd: opts.workDir,
        allowFailure: true,
      });
      swept.push({ worktreePath: wt, branch, mergedAt });
    } catch {
      // remove may fail if path no longer registered — already swept by sibling run
    }
  }

  return { swept };
}
