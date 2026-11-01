/**
 * Step 0 — Sweep leftover worktrees (AISDLC-1108).
 *
 * Mirrors `ai-sdlc-plugin/commands/execute.md` Step 0. Walks
 * `<workDir>/.worktrees/` and removes every worktree that
 * {@link worktreeDisposition} classes as `remove-*`: merged, closed-unmerged,
 * no PR past the grace window, or an open PR whose branch head has not moved
 * for the stale window. Inflight tasks (board claim or a fresh `.active-task`
 * sentinel) are never removed. Branches are never deleted: only the directory
 * goes, and a resume recreates it from the branch.
 *
 * Pure with respect to its inputs — accepts a `Runner` so tests can stub
 * `git` / `gh` invocations without any side effects.
 *
 * ## PR state is looked up per branch
 *
 * `gh pr list --head <branch> --state all` (AISDLC-204: `--state all` keeps
 * squash-merged PRs whose source branch was deleted visible). A single
 * `--limit 200` list silently lost every PR older than the 200 most recent,
 * which left those worktrees "no PR" forever. A failed lookup leaves the
 * worktree alone; it is never treated as "no PR".
 *
 * Removal uses `git worktree remove --force` (a dirty tree no longer blocks it;
 * the untracked paths are logged), checks the exit code and falls back to
 * `rm -rf` plus `git worktree prune`. A failed removal is reported, never counted
 * as swept.
 *
 * @module steps/00-sweep
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SweepResult } from '../types.js';
import { listInflight } from '../hierarchy/inflight.js';
import {
  WORKTREE_SWEEP_DEFAULTS,
  isRemoval,
  worktreeDisposition,
  type WorktreeDisposition,
  type WorktreeSweepConfig,
} from './00-worktree-disposition.js';

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
  /** Windows and ceiling; defaults to {@link WORKTREE_SWEEP_DEFAULTS}. */
  config?: WorktreeSweepConfig;
  /** Clock for the age rules (tests). */
  now?: () => number;
  /** Classify only: report what would go, remove nothing and write no status file. */
  dryRun?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** Last-sweep summary read by `cli-hierarchy status`. */
export const SWEEP_STATUS_FILE = join('.git', 'ai-sdlc-sweep-status.json');

export interface SweepStatusRecord {
  at: string;
  /** Worktree directories left after the sweep. */
  count: number;
  /** Of those, how many are classed `remove-*` but could not be removed. */
  removable: number;
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
 * Resolve one branch's PR with `gh pr list --head <branch> --state all`. When
 * the branch has several PRs, an OPEN one wins (the branch is back in flight),
 * otherwise the newest. Returns `null` on any gh/parse failure so the caller
 * keeps the worktree instead of guessing "no PR".
 */
export async function lookupPrForBranch(
  workDir: string,
  branch: string,
  runner: Runner,
): Promise<PrInfo | null> {
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
        '--limit',
        '10',
        '--json',
        'number,state,mergedAt,closedAt',
      ],
      { allowFailure: true, cwd: workDir },
    );
    if (r.code !== 0) return null;
    const raw = r.stdout.trim();
    if (!raw || raw === 'null') return NO_PR;
    const prs = JSON.parse(raw) as Array<{
      number?: number;
      state?: string;
      mergedAt?: string | null;
    }>;
    let best: { number?: number; state?: string; mergedAt?: string | null } | undefined;
    for (const pr of prs) {
      if (!pr.state) continue;
      if (!best) {
        best = pr;
        continue;
      }
      const bestOpen = best.state === 'OPEN';
      const open = pr.state === 'OPEN';
      if (bestOpen !== open ? open : (pr.number ?? 0) > (best.number ?? 0)) best = pr;
    }
    return best ? { state: best.state ?? null, mergedAt: best.mergedAt ?? null } : NO_PR;
  } catch {
    return null;
  }
}

/** Untracked and modified paths of a worktree, for the info log; empty on any failure. */
async function dirtyPaths(wt: string, runner: Runner): Promise<string[]> {
  try {
    const r = await runner('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], {
      allowFailure: true,
    });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Age in ms of the branch head commit; null when git cannot say. */
async function headAgeMs(wt: string, runner: Runner, nowMs: number): Promise<number | null> {
  try {
    const r = await runner('git', ['-C', wt, 'log', '-1', '--format=%ct'], { allowFailure: true });
    if (r.code !== 0) return null;
    const sec = Number(r.stdout.trim());
    return Number.isFinite(sec) && sec > 0 ? nowMs - sec * 1000 : null;
  } catch {
    return null;
  }
}

type Removal = { ok: true; fallback: boolean } | { ok: false; reason: string };

/** `git worktree remove --force`, checked; on refusal `rm -rf` plus `git worktree prune`. */
async function removeWorktree(wt: string, workDir: string, runner: Runner): Promise<Removal> {
  let refusal: string;
  try {
    const r = await runner('git', ['worktree', 'remove', '--force', wt], {
      cwd: workDir,
      allowFailure: true,
    });
    if (r.code === 0) return { ok: true, fallback: false };
    refusal = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
  } catch (err) {
    refusal = (err as Error).message;
  }
  try {
    rmSync(wt, { recursive: true, force: true });
    await runner('git', ['worktree', 'prune'], { cwd: workDir, allowFailure: true });
  } catch (err) {
    return {
      ok: false,
      reason: `git refused (${refusal}); rm -rf failed: ${(err as Error).message}`,
    };
  }
  if (existsSync(wt)) return { ok: false, reason: `git refused (${refusal}); directory remains` };
  return { ok: true, fallback: true };
}

export async function sweepMergedWorktrees(opts: SweepOptions): Promise<SweepResult> {
  const runner = opts.runner ?? defaultRunner;
  const config = opts.config ?? WORKTREE_SWEEP_DEFAULTS;
  const nowMs = (opts.now ?? Date.now)();
  const log = opts.logger ?? {
    info: (m: string) => console.info(m),
    warn: (m: string) => console.warn(m),
  };
  const worktreesDir = join(opts.workDir, '.worktrees');
  const boardDir = opts.boardDir ?? join(opts.workDir, '.ai-sdlc', 'dispatch');

  if (!existsSync(worktreesDir)) {
    return { swept: [] };
  }

  const swept: SweepResult['swept'] = [];
  const failed: NonNullable<SweepResult['failed']> = [];

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return { swept: [] };
  }

  let inflight: Set<string>;
  try {
    inflight = new Set(listInflight(boardDir).map((i) => i.taskId.toLowerCase()));
  } catch {
    inflight = new Set();
  }

  // Pass 1 (local only): branch, HEAD sha, sentinel and directory ages per worktree.
  const found: Array<{
    entry: string;
    wt: string;
    branch: string;
    headSha: string;
    inflight: boolean;
    sentinelAgeMs: number | null;
    dirAgeMs: number;
  }> = [];
  let count = 0;
  for (const entry of entries) {
    const wt = join(worktreesDir, entry);
    let st;
    try {
      st = statSync(wt);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    count++;

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
    let sentinelAgeMs: number | null = null;
    try {
      sentinelAgeMs = nowMs - statSync(join(wt, '.active-task')).mtimeMs;
    } catch {
      // no sentinel
    }
    found.push({
      entry,
      wt,
      branch,
      headSha,
      inflight: inflight.has(entry.toLowerCase()),
      sentinelAgeMs,
      dirAgeMs: nowMs - st.mtimeMs,
    });
  }

  // Cache: drop entries for branches with no worktree any more, serve
  // landed/closed branches without a GitHub call (AISDLC-958). Inflight
  // worktrees need no PR state at all.
  const cachePath = join(opts.workDir, SWEEP_CACHE_FILE);
  const oldCache = readCache(cachePath);
  const cache: SweepCache = {};
  const resolved = new Map<string, PrInfo | null>();
  const isProtected = (f: { inflight: boolean; sentinelAgeMs: number | null }): boolean =>
    f.inflight || (f.sentinelAgeMs !== null && f.sentinelAgeMs < config.sentinelMs);
  for (const f of found) {
    if (resolved.has(f.branch) || isProtected(f)) continue;
    const hit = oldCache[f.branch];
    if (opts.knownOpenBranches?.has(f.branch)) {
      resolved.set(f.branch, { state: 'OPEN', mergedAt: null });
    } else if (hit && f.headSha !== '' && hit.headSha === f.headSha) {
      cache[f.branch] = hit;
      resolved.set(f.branch, { state: hit.state, mergedAt: hit.mergedAt });
    } else {
      const info = await lookupPrForBranch(opts.workDir, f.branch, runner);
      resolved.set(f.branch, info);
      if (info && (info.state === 'MERGED' || info.state === 'CLOSED') && f.headSha !== '') {
        cache[f.branch] = { state: info.state, mergedAt: info.mergedAt, headSha: f.headSha };
      }
    }
  }

  for (const f of found) {
    const { entry, wt, branch } = f;
    if (isProtected(f)) continue;
    const info = resolved.get(branch);
    // A failed lookup is unknown, not "no PR": keep the worktree.
    if (info === null || info === undefined) continue;
    const prState =
      info.state === 'OPEN' || info.state === 'MERGED' || info.state === 'CLOSED'
        ? info.state
        : null;
    const mergedAt = info.mergedAt;
    const disposition: WorktreeDisposition = worktreeDisposition(
      {
        onBoardInflight: f.inflight,
        sentinelAgeMs: f.sentinelAgeMs,
        dirAgeMs: f.dirAgeMs,
        prState,
        headAgeMs: prState === 'OPEN' ? await headAgeMs(wt, runner, nowMs) : null,
      },
      config,
    );
    if (!isRemoval(disposition)) continue;
    if (opts.dryRun) {
      swept.push({
        worktreePath: wt,
        branch,
        mergedAt: mergedAt ?? 'unknown',
        taskId: entry,
        disposition,
      });
      continue;
    }

    const dirty = await dirtyPaths(wt, runner);
    if (dirty.length > 0) {
      log.info(
        `[step-0-sweep] ${branch}: removing ${disposition} worktree with ${dirty.length} untracked or modified path(s) at ${wt}: ${dirty.slice(0, 20).join(', ')}${dirty.length > 20 ? ', ...' : ''}`,
      );
    }
    const removal = await removeWorktree(wt, opts.workDir, runner);
    if (!removal.ok) {
      log.warn(`[step-0-sweep] ${branch}: removal FAILED at ${wt}: ${removal.reason}`);
      failed.push({ worktreePath: wt, branch, reason: removal.reason });
      continue;
    }
    count--;
    if (removal.fallback) {
      log.warn(
        `[step-0-sweep] ${branch}: git refused the removal; fell back to rm -rf + git worktree prune at ${wt}`,
      );
    }

    // AISDLC-493 — populate dispatch→merge profiling fields (merged only, best-effort).
    const taskIdLower = entry.toLowerCase();
    let dispatchedAt: string | undefined;
    let totalLifecycleMs: number | undefined;
    let ciWaitMs: number | null | undefined;
    if (disposition === 'remove-merged') {
      dispatchedAt = readDispatchedAtFromVerdict(boardDir, taskIdLower);
      if (dispatchedAt && mergedAt) {
        const dispMs = Date.parse(dispatchedAt);
        const mergedMs = Date.parse(mergedAt);
        if (!Number.isNaN(dispMs) && !Number.isNaN(mergedMs) && mergedMs >= dispMs) {
          totalLifecycleMs = mergedMs - dispMs;
        }
      }
      ciWaitMs = await deriveCiWaitMs(branch, opts.workDir, runner);
    }

    swept.push({
      worktreePath: wt,
      branch,
      mergedAt: mergedAt ?? 'unknown',
      taskId: entry, // entry is the directory name = task-id-lower
      disposition,
      ...(dispatchedAt !== undefined ? { dispatchedAt } : {}),
      ...(totalLifecycleMs !== undefined ? { totalLifecycleMs } : {}),
      ...(ciWaitMs !== undefined ? { ciWaitMs } : {}),
    });
  }

  if (!opts.dryRun) {
    // Removed worktrees drop out of the cache immediately.
    for (const s of swept) delete cache[s.branch];
    if (JSON.stringify(cache) !== JSON.stringify(oldCache)) writeCache(cachePath, cache);
    try {
      const record: SweepStatusRecord = {
        at: new Date(nowMs).toISOString(),
        count,
        removable: failed.length,
      };
      // Under .git so it is never an untracked file in the parent (Step 0.5 would stop on it).
      const p = join(opts.workDir, SWEEP_STATUS_FILE);
      writeFileSync(p, JSON.stringify(record) + '\n');
    } catch {
      // best-effort
    }
  }

  return failed.length > 0 ? { swept, failed } : { swept };
}

/** Tick counter for `hierarchy.worktrees.sweepEveryTicks`; each tick is its own process. */
export const SWEEP_TICK_FILE = join('.git', 'ai-sdlc-sweep-tick-counter');

/** Count this tick and say whether the sweep runs on it (the first tick, then every N-th). */
export function sweepDue(workDir: string, everyTicks: number): boolean {
  if (everyTicks <= 1) return true;
  const p = join(workDir, SWEEP_TICK_FILE);
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(p, 'utf8'), 10) || 0;
  } catch {
    // first tick
  }
  try {
    writeFileSync(p, String((n + 1) % everyTicks) + '\n');
  } catch {
    return true; // no .git directory to hold the counter: sweep every tick
  }
  return n % everyTicks === 0;
}
