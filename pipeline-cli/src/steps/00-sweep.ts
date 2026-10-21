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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  /**
   * AISDLC-981 — branches already known to have an OPEN PR (the dispatch tick's
   * reconciler snapshot). They are resolved as OPEN without a gh call, so a sweep
   * whose worktrees are all in flight makes none.
   */
  knownOpenBranches?: ReadonlySet<string>;
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

export interface PrInfo {
  state: string | null;
  mergedAt: string | null;
}

const NO_PR: PrInfo = { state: null, mergedAt: null };

/** Max PRs fetched by the single batched query (AISDLC-958). */
export const SWEEP_PR_LIST_LIMIT = 200;

/** On-disk cache of branches whose PR is permanently landed or closed. */
export const SWEEP_CACHE_FILE = join('.ai-sdlc', 'sweep-landed-cache.json');

interface CacheEntry {
  state: 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  /** Worktree HEAD sha when cached; a different sha means new work, so re-query. */
  headSha: string;
}
type SweepCache = Record<string, CacheEntry>;

function readCache(path: string): SweepCache {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SweepCache;
    }
  } catch {
    // missing or corrupt cache: start empty
  }
  return {};
}

function writeCache(path: string, cache: SweepCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
  } catch {
    // best-effort
  }
}

/**
 * AISDLC-958 — ONE `gh pr list --state all` for the whole sweep, matched to
 * branches locally. `--state all` keeps squash-merged PRs whose source branch
 * was deleted visible (AISDLC-204). When a branch has several PRs, an OPEN one
 * wins (the branch is back in flight), otherwise the most recently listed.
 *
 * Returns `null` on any gh/parse failure so the caller skips silently.
 */
export async function listPrStatesByBranch(
  workDir: string,
  runner: Runner,
): Promise<Map<string, PrInfo> | null> {
  try {
    const r = await runner(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        String(SWEEP_PR_LIST_LIMIT),
        '--json',
        'number,state,headRefName,mergedAt',
      ],
      { allowFailure: true, cwd: workDir },
    );
    if (r.code !== 0) return null;
    const raw = r.stdout.trim();
    if (!raw || raw === 'null') return new Map();
    const prs = JSON.parse(raw) as Array<{
      number?: number;
      state?: string;
      headRefName?: string;
      mergedAt?: string | null;
    }>;
    const byBranch = new Map<string, { info: PrInfo; number: number }>();
    for (const pr of prs) {
      if (!pr.headRefName || !pr.state) continue;
      const num = pr.number ?? 0;
      const prev = byBranch.get(pr.headRefName);
      if (prev) {
        const prevOpen = prev.info.state === 'OPEN';
        const open = pr.state === 'OPEN';
        if (prevOpen !== open ? prevOpen : num < prev.number) continue;
      }
      byBranch.set(pr.headRefName, {
        info: { state: pr.state, mergedAt: pr.mergedAt ?? null },
        number: num,
      });
    }
    return new Map([...byBranch].map(([k, v]) => [k, v.info]));
  } catch {
    return null;
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

  // Pass 1 (local git only): resolve each worktree's branch and HEAD sha.
  const found: Array<{ entry: string; wt: string; branch: string; headSha: string }> = [];
  for (const entry of entries) {
    const wt = join(worktreesDir, entry);
    let isDir: boolean;
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

    let headSha = '';
    try {
      const r = await runner('git', ['-C', wt, 'rev-parse', 'HEAD'], { allowFailure: true });
      if (r.code === 0) headSha = r.stdout.trim();
    } catch {
      // no sha: entry is never served from cache
    }
    found.push({ entry, wt, branch, headSha });
  }

  // Cache: drop entries for branches with no worktree any more (AC2), serve
  // landed/closed branches without a GitHub call (AISDLC-958).
  const cachePath = join(opts.workDir, SWEEP_CACHE_FILE);
  const oldCache = readCache(cachePath);
  const cache: SweepCache = {};
  const resolved = new Map<string, PrInfo>();
  const uncached: typeof found = [];
  for (const f of found) {
    const hit = oldCache[f.branch];
    if (opts.knownOpenBranches?.has(f.branch)) {
      resolved.set(f.branch, { state: 'OPEN', mergedAt: null });
    } else if (hit && f.headSha !== '' && hit.headSha === f.headSha) {
      cache[f.branch] = hit;
      resolved.set(f.branch, { state: hit.state, mergedAt: hit.mergedAt });
    } else {
      uncached.push(f);
    }
  }
  if (uncached.length > 0) {
    const listed = await listPrStatesByBranch(opts.workDir, runner);
    for (const f of uncached) {
      const info = listed?.get(f.branch) ?? NO_PR;
      resolved.set(f.branch, info);
      if ((info.state === 'MERGED' || info.state === 'CLOSED') && f.headSha !== '') {
        cache[f.branch] = { state: info.state, mergedAt: info.mergedAt, headSha: f.headSha };
      }
    }
  }
  for (const { entry, wt, branch } of found) {
    // Only remove MERGED, not CLOSED (abandoned work may be salvageable).
    const { state, mergedAt } = resolved.get(branch) ?? NO_PR;
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

  // Removed worktrees drop out of the cache immediately.
  for (const s of swept) delete cache[s.branch];
  if (JSON.stringify(cache) !== JSON.stringify(oldCache)) writeCache(cachePath, cache);

  return { swept };
}
