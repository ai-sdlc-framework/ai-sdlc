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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SweepResult } from '../types.js';

export interface SweepOptions {
  workDir: string;
  runner?: Runner;
  /**
   * AISDLC-493 — override the board directory for dispatch verdicts.
   * Defaults to `<workDir>/.ai-sdlc/dispatch`. Tests inject a tmp path.
   */
  boardDir?: string;
}

// ── AISDLC-493 profiling helpers ──────────────────────────────────────────

/**
 * Try to read `dispatchedAt` from the dispatch verdict JSON for a given
 * task. Checks both `done/` and `failed/` subdirectories of the board.
 * Returns `undefined` when no verdict file exists or the field is absent.
 * Best-effort — parse errors are silently swallowed.
 */
export function readDispatchedAtFromVerdict(
  boardDir: string,
  taskIdLower: string,
): string | undefined {
  for (const sub of ['done', 'failed'] as const) {
    const p = join(boardDir, sub, `${taskIdLower}.verdict.json`);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (typeof v.dispatchedAt === 'string' && v.dispatchedAt.length > 0) {
        return v.dispatchedAt;
      }
    } catch {
      // skip malformed file
    }
  }
  return undefined;
}

/**
 * Derive a best-effort CI-wait duration from `gh run list` for the given
 * branch. Looks for the most-recent CI run that completed around the PR
 * merge time. Returns `null` when no matching run is found or the runner
 * returns a non-zero exit.
 *
 * This is the "retroactive, no blocking poll, no webhook" CI-wait derivation
 * described in AISDLC-493 §Scope item 4.
 */
export async function deriveCiWaitMs(
  branch: string,
  workDir: string,
  runner: Runner,
): Promise<number | null> {
  try {
    const r = await runner(
      'gh',
      [
        'run',
        'list',
        '--branch',
        branch,
        '--json',
        'conclusion,startedAt,completedAt',
        '--limit',
        '5',
      ],
      { allowFailure: true, cwd: workDir },
    );
    if (r.code !== 0) return null;
    const raw = r.stdout.trim();
    if (!raw || raw === 'null' || raw === '[]') return null;
    const runs = JSON.parse(raw) as Array<{
      conclusion?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    }>;
    // Find the most recent completed run (success or failure — both count
    // as "CI waited").
    for (const run of runs) {
      if (!run.startedAt || !run.completedAt) continue;
      const start = Date.parse(run.startedAt);
      const end = Date.parse(run.completedAt);
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
      return end - start;
    }
    return null;
  } catch {
    return null;
  }
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
  const boardDir = opts.boardDir ?? join(opts.workDir, '.ai-sdlc', 'dispatch');

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

      // AISDLC-493 — populate dispatch→merge profiling fields (best-effort).
      const taskIdLower = entry.toLowerCase();
      const dispatchedAt = readDispatchedAtFromVerdict(boardDir, taskIdLower);
      let totalLifecycleMs: number | undefined;
      if (dispatchedAt && mergedAt) {
        const dispMs = Date.parse(dispatchedAt);
        const mergedMs = Date.parse(mergedAt);
        if (!Number.isNaN(dispMs) && !Number.isNaN(mergedMs) && mergedMs >= dispMs) {
          totalLifecycleMs = mergedMs - dispMs;
        }
      }
      const ciWaitMs = await deriveCiWaitMs(branch, opts.workDir, runner);

      swept.push({
        worktreePath: wt,
        branch,
        mergedAt: mergedAtStr,
        taskId: entry, // entry is the directory name = task-id-lower
        ...(dispatchedAt !== undefined ? { dispatchedAt } : {}),
        ...(totalLifecycleMs !== undefined ? { totalLifecycleMs } : {}),
        ciWaitMs: ciWaitMs,
      });
    } catch {
      // remove may fail if path no longer registered — already swept by sibling run
    }
  }

  return { swept };
}
