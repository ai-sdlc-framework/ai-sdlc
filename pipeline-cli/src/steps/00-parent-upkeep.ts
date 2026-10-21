/**
 * Parent-checkout upkeep (AISDLC-981).
 *
 * The parent checkout changes once per landed PR, and three executors share it
 * and one gh quota, so its repairs belong to the dispatch tick (once per tick),
 * not to every task start:
 *
 *   - orchestrator-state recovery (`check-orchestrator-state.sh`, Step 0)
 *   - merged-worktree sweep (Step 0)
 *   - untracked-file sync and stale-debris prune (Step 0.5 / 0.5b)
 *
 * The execute path only {@link assertParentClean}s, unless it runs standalone
 * (no hierarchy session) or `AI_SDLC_PARENT_UPKEEP=inline` asks for the repairs
 * ({@link parentUpkeepMode}).
 *
 * @module steps/00-parent-upkeep
 */

import { join } from 'node:path';
import type { Runner } from '../runtime/exec.js';
import { sweepMergedWorktrees } from './00-sweep.js';
import { pruneStaleParentDebris, syncParentUntrackedFiles } from './00-5-sync-parent.js';

export interface UpkeepLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ParentUpkeepOptions {
  workDir: string;
  runner: Runner;
  /** Directory holding `check-orchestrator-state.sh`. */
  pluginScriptsDir: string;
  exists: (path: string) => boolean;
  logger?: UpkeepLogger;
  /** Branches the reconciler snapshot already shows with an open PR. */
  knownOpenBranches?: ReadonlySet<string>;
}

export type ParentUpkeepResult =
  | { ok: true; swept: number }
  | { ok: false; reason: string; swept: number };

/** Where the parent mutations run for this process. */
export function parentUpkeepMode(env: NodeJS.ProcessEnv): 'inline' | 'assert' {
  if (env['AI_SDLC_PARENT_UPKEEP'] === 'inline') return 'inline';
  if (env['AI_SDLC_PARENT_UPKEEP'] === 'assert') return 'assert';
  // A hierarchy session (executor) leaves the parent to the dispatch tick.
  return env['AI_SDLC_HIERARCHY_SESSION'] ? 'assert' : 'inline';
}

/** Run the parent mutations once: recovery, sweep, untracked sync, debris prune. */
export async function runParentUpkeep(opts: ParentUpkeepOptions): Promise<ParentUpkeepResult> {
  const { workDir, runner, logger } = opts;

  const stateScript = join(opts.pluginScriptsDir, 'check-orchestrator-state.sh');
  if (opts.exists(stateScript)) {
    const heal = await runner('bash', [stateScript], {
      cwd: workDir,
      allowFailure: true,
      timeout: 120_000,
    });
    if (heal.code !== 0) {
      return {
        ok: false,
        swept: 0,
        reason: `Step 0 orchestrator-state check refused: ${(heal.stderr || heal.stdout).trim()}`,
      };
    }
  }
  const sweep = await sweepMergedWorktrees({
    workDir,
    runner,
    ...(opts.knownOpenBranches ? { knownOpenBranches: opts.knownOpenBranches } : {}),
  });
  for (const s of sweep.swept) logger?.info(`Sweeping merged worktree: ${JSON.stringify(s)}`);

  // Step 0.5 — non-backlog untracked files in the parent are a hard stop.
  const sync = await syncParentUntrackedFiles({ workDir, runner });
  if (!sync.ok) {
    return {
      ok: false,
      swept: sweep.swept.length,
      reason: sync.reason ?? 'Step 0.5 sync-parent failed',
    };
  }
  logger?.info(`[Step 0.5] ${JSON.stringify(sync)}`);
  try {
    const pruned = await pruneStaleParentDebris({ workDir, runner });
    if (!pruned.ok) logger?.warn('Step 0.5b: prune-stale-parent-debris reported failure');
  } catch (err) {
    logger?.warn(`Step 0.5b: prune failed (non-fatal): ${(err as Error).message}`);
  }
  return { ok: true, swept: sweep.swept.length };
}

const REPAIR =
  'the dispatch tick repairs the parent (cli-hierarchy tick); wait for the next tick, or run ' +
  'this command standalone with AI_SDLC_PARENT_UPKEEP=inline';

/** Read-only check: parent on main, no tracked changes, HEAD at or behind origin/main. */
export async function assertParentClean(
  workDir: string,
  runner: Runner,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const git = (args: string[]) => runner('git', args, { cwd: workDir, allowFailure: true });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code !== 0 || branch.stdout.trim() !== 'main') {
    return {
      ok: false,
      reason: `Step 0 parent check refused: the parent is on '${branch.stdout.trim() || 'an unknown ref'}', not main; ${REPAIR}`,
    };
  }
  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return {
      ok: false,
      reason: `Step 0 parent check refused: the parent has tracked changes; ${REPAIR}`,
    };
  }
  const behind = await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  if (behind.code !== 0) {
    return {
      ok: false,
      reason: `Step 0 parent check refused: the parent HEAD is not at or behind origin/main; ${REPAIR}`,
    };
  }
  return { ok: true };
}
