/**
 * Step 0 — Sweep merged worktrees.
 *
 * Mirrors `ai-sdlc-plugin/commands/execute.md` Step 0. Walks
 * `<workDir>/.worktrees/`, looks up each worktree's branch, and removes
 * the worktree if the corresponding GitHub PR has merged.
 *
 * Pure with respect to its inputs — accepts a `Runner` so tests can stub
 * `git` / `gh` invocations without any side effects.
 *
 * Idempotent and parallel-safe: `git worktree remove --force` on an
 * already-swept entry is a no-op.
 *
 * ## Why `--state all` instead of `--state merged` (AISDLC-204)
 *
 * `gh pr list --head <branch> --state merged` returns an empty array once the
 * source branch has been deleted from the remote. This is the normal case for
 * this repo: `delete_branch_on_merge: true` means every squash-merged PR has
 * its source branch removed immediately. The `--head` filter matches on the
 * CURRENT remote ref, not on historical head associations, so deleted branches
 * produce zero results even when the PR itself is `MERGED`.
 *
 * The fix is `--state all`, which includes open, closed, and merged PRs
 * regardless of source-branch existence. We then filter client-side by
 * `.state === "MERGED"` to keep the same intent (only sweep merged PRs, not
 * abandoned-and-closed ones).
 *
 * Closed (abandoned) PRs are intentionally NOT swept — those need explicit
 * operator cleanup because the work may be salvageable.
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

/**
 * Look up the PR state for `branch` using `--state all` so squash-merged PRs
 * (whose source branch was deleted from the remote) are still found.
 *
 * Returns `{ state, mergedAt }` where `state` is `"MERGED"`, `"OPEN"`,
 * `"CLOSED"`, or `null` (no PR found / network failure).
 */
export async function lookupPrState(
  branch: string,
  workDir: string,
  runner: Runner,
): Promise<{ state: string | null; mergedAt: string | null }> {
  try {
    const r = await runner(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,state,mergedAt',
        '--jq',
        '.[0]',
      ],
      { allowFailure: true, cwd: workDir },
    );
    if (r.code !== 0) return { state: null, mergedAt: null };
    const raw = r.stdout.trim();
    if (!raw || raw === 'null') return { state: null, mergedAt: null };
    const parsed = JSON.parse(raw) as { state?: string; mergedAt?: string | null };
    const state = parsed.state ?? null;
    const mergedAt = parsed.mergedAt ?? null;
    return { state, mergedAt };
  } catch {
    // network/auth/parse failure — caller skips silently
    return { state: null, mergedAt: null };
  }
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

    // Query with --state all so squash-merged PRs with deleted source branches
    // are found (AISDLC-204). Filter client-side: only remove MERGED, not CLOSED.
    const { state, mergedAt } = await lookupPrState(branch, opts.workDir, runner);
    if (state !== 'MERGED') continue;

    // AISDLC-256 security minor: don't `--force` remove a worktree that has
    // uncommitted changes. Mirrors the WorktreeAutoCleaned guard from
    // AISDLC-224 — if `gh` returns a spurious MERGED state (API race, cached
    // stale response, or accidental early merge of an in-progress branch),
    // refusing to wipe a dirty worktree gives the operator a recovery window.
    try {
      const status = await runner('git', ['-C', wt, 'status', '--porcelain'], {
        allowFailure: true,
      });
      // Conservative: skip removal in BOTH cases — dirty worktree OR
      // status check itself failed (the runner uses allowFailure so a
      // non-zero exit returns code != 0 instead of throwing). Either way,
      // we don't have a reliable signal that the tree is clean.
      if (status.code !== 0) {
        console.warn(
          `[step-0-sweep] ${branch}: SKIPPED removal — git status check failed ` +
            `(exit ${status.code}) at ${wt}. Conservative skip; inspect manually.`,
        );
        continue;
      }
      if (status.stdout.trim().length > 0) {
        // Dirty worktree — skip removal, log + leave for operator to inspect.
        // Not pushing this to `swept` so the consumer (orchestrator loop)
        // doesn't emit a misleading OrchestratorWorktreeSwept event.

        console.warn(
          `[step-0-sweep] ${branch}: SKIPPED removal — worktree has uncommitted changes ` +
            `at ${wt} despite PR being MERGED. Inspect manually before re-running.`,
        );
        continue;
      }
    } catch {
      // Defense-in-depth: even with allowFailure: true, a thrown error
      // (e.g. runner mock that throws) falls here. Same conservative skip.
      continue;
    }

    const mergedAtStr = mergedAt ?? 'unknown';
    try {
      await runner('git', ['worktree', 'remove', '--force', wt], {
        cwd: opts.workDir,
        allowFailure: true,
      });
      swept.push({ worktreePath: wt, branch, mergedAt: mergedAtStr });
    } catch {
      // remove may fail if path no longer registered — already swept by sibling run
    }
  }

  return { swept };
}
