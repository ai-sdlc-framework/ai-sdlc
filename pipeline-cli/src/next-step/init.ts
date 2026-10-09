/**
 * First `next-step` call: Steps 0-5 of the pipeline, all deterministic.
 *
 *   0    parent self-heal + merged-worktree sweep
 *   0.5  sync untracked parent task files, prune stale debris
 *   1    validate the backlog task, dependency pre-flight (AISDLC-117)
 *   2-4  branch name, worktree (+ hooks check, AISDLC-693), In Progress + sentinel
 *   5    developer prompt (written to a file for the model to hand to the agent)
 *
 * @module next-step/init
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBranchName } from '../steps/02-compute-branch.js';
import { setupWorktree } from '../steps/03-setup-worktree.js';
import { beginTask } from '../steps/04-flip-status.js';
import { buildDeveloperPrompt } from '../steps/05-build-dev-prompt.js';
import { sweepMergedWorktrees } from '../steps/00-sweep.js';
import { pruneStaleParentDebris, syncParentUntrackedFiles } from '../steps/00-5-sync-parent.js';
import { validateTask } from '../steps/01-validate.js';
import type { NextStepContext } from './types.js';
import type { TaskSpec } from '../types.js';

export interface InitSuccess {
  ok: true;
  branch: string;
  worktreePath: string;
  task: TaskSpec;
  fromStatus: string;
  promptFile: string;
  model?: string;
}

export interface InitFailure {
  ok: false;
  reason: string;
}

/** Read the `status:` frontmatter value, defaulting to `To Do`. */
export function statusOf(task: TaskSpec): string {
  return task.status?.trim() || 'To Do';
}

/** Write a prompt (or any scratch text) under the run's files directory. */
export function writeRunFile(ctx: NextStepContext, name: string, content: string): string {
  mkdirSync(ctx.filesDir, { recursive: true });
  const file = join(ctx.filesDir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

export async function initTask(
  ctx: NextStepContext,
  taskId: string,
): Promise<InitSuccess | InitFailure> {
  const { workDir, runner } = ctx;

  // Step 0 — self-heal the parent (Pattern C: parent stays on a clean main).
  const stateScript = join(ctx.pluginScriptsDir, 'check-orchestrator-state.sh');
  if (ctx.exists(stateScript)) {
    const heal = await runner('bash', [stateScript], {
      cwd: workDir,
      allowFailure: true,
      timeout: 120_000,
    });
    if (heal.code !== 0) {
      return {
        ok: false,
        reason: `Step 0 orchestrator-state check refused: ${(heal.stderr || heal.stdout).trim()}`,
      };
    }
  }
  const sweep = await sweepMergedWorktrees({ workDir, runner });
  for (const s of sweep.swept) ctx.logger.info(`Sweeping merged worktree: ${JSON.stringify(s)}`);

  // Step 0.5 — non-backlog untracked files in the parent are a hard stop.
  const sync = await syncParentUntrackedFiles({ workDir, runner });
  if (!sync.ok) {
    return { ok: false, reason: sync.reason ?? 'Step 0.5 sync-parent failed' };
  }
  ctx.logger.info(`[Step 0.5] ${JSON.stringify(sync)}`);
  try {
    const pruned = await pruneStaleParentDebris({ workDir, runner });
    if (!pruned.ok) ctx.logger.warn(`Step 0.5b: prune-stale-parent-debris reported failure`);
  } catch (err) {
    ctx.logger.warn(`Step 0.5b: prune failed (non-fatal): ${(err as Error).message}`);
  }

  // Step 1 — validate.
  const validation = await validateTask({ taskId, workDir });
  if (!validation.ok || !validation.task) {
    return { ok: false, reason: validation.reason ?? 'validation failed' };
  }
  const task = validation.task;

  // Step 1.5 — dependency pre-flight. Fail-closed: a broken cli-deps aborts too.
  const preflight = await runner(
    'node',
    [join(ctx.cliBinDir, 'cli-deps.mjs'), 'preflight', taskId, '--work-dir', workDir],
    { cwd: workDir, allowFailure: true, timeout: 120_000 },
  );
  if (preflight.code !== 0) {
    return {
      ok: false,
      reason:
        `dependency preflight failed for ${taskId}: ${(preflight.stderr || preflight.stdout).trim()}\n` +
        `To inspect the dispatch-ready frontier: node ${join(ctx.cliBinDir, 'cli-deps.mjs')} frontier --format table`,
    };
  }

  // Steps 2-4.
  const branch = await computeBranchName({ taskId, task, workDir });
  await setupWorktree({
    taskId,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    workDir,
    runner,
  });
  await beginTask({ taskId, worktreePath: branch.worktreePath, workDir, sourceKind: 'backlog' });

  // Step 5 — developer prompt, iteration 1.
  const built = await buildDeveloperPrompt({
    taskId,
    task,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    iteration: 1,
    sourceKind: 'backlog',
  });
  const promptFile = writeRunFile(ctx, 'developer-prompt-1.md', built.prompt);
  return {
    ok: true,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    task,
    fromStatus: statusOf(task),
    promptFile,
    ...(built.model && built.modelArm !== 'default' ? { model: built.model } : {}),
  };
}
