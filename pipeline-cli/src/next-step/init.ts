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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBranchName } from '../steps/02-compute-branch.js';
import { resolveResumeBranch } from './resume-branch.js';
import { setupWorktree } from '../steps/03-setup-worktree.js';
import { beginTask, patchFrontmatterStatus } from '../steps/04-flip-status.js';
import { cleanupTask } from '../steps/13-cleanup.js';
import { buildDeveloperPrompt } from '../steps/05-build-dev-prompt.js';
import { sweepMergedWorktrees } from '../steps/00-sweep.js';
import { pruneStaleParentDebris, syncParentUntrackedFiles } from '../steps/00-5-sync-parent.js';
import { findTaskFile, validateTask } from '../steps/01-validate.js';
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
  // AISDLC-762.2: on a resume the branch is read from the manifest, the PR or the
  // worktree; the title-derived name is computed only for a fresh task.
  const known = await resolveResumeBranch(ctx, taskId);
  const branch = known
    ? { branch: known.branch, worktreePath: join(workDir, '.worktrees', taskId.toLowerCase()) }
    : await computeBranchName({ taskId, task, workDir });
  const resume = known ? true : await hasExistingWork(ctx, branch.branch, branch.worktreePath);
  if (known) {
    ctx.logger.info(`[Step 3] resuming ${branch.branch} (source: ${known.source})`);
  } else if (resume) {
    ctx.logger.info(`[Step 3] ${branch.branch} already exists: resuming it (source: recomputed)`);
  }
  await setupWorktree({
    taskId,
    branch: branch.branch,
    worktreePath: branch.worktreePath,
    workDir,
    runner,
    ...(resume ? { resume: true } : {}),
  });
  await beginTask({ taskId, worktreePath: branch.worktreePath, workDir, sourceKind: 'backlog' });

  let built: Awaited<ReturnType<typeof buildDeveloperPrompt>>;
  let promptFile: string;
  try {
    // Step 5 — developer prompt, iteration 1.
    built = await buildDeveloperPrompt({
      taskId,
      task,
      branch: branch.branch,
      worktreePath: branch.worktreePath,
      iteration: 1,
      sourceKind: 'backlog',
    });
    promptFile = writeRunFile(ctx, 'developer-prompt-1.md', built.prompt);
  } catch (err) {
    await rollbackBegun(taskId, task, branch.worktreePath);
    throw err;
  }
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

/**
 * AISDLC-762.1 — the task's worktree or branch (local, or pushed to origin)
 * already exists: this is a resume (a dispatch resume, an iterate-needed or
 * failed round, or a zero-commit leftover), so Step 3 re-enters it instead of
 * refusing. A fresh task has none of the three.
 */
async function hasExistingWork(
  ctx: NextStepContext,
  branch: string,
  worktreePath: string,
): Promise<boolean> {
  if (existsSync(join(worktreePath, '.git'))) return true;
  const { workDir, runner } = ctx;
  await runner('git', ['fetch', 'origin', '--', branch], {
    cwd: workDir,
    timeout: 30_000,
    allowFailure: true,
  });
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const r = await runner('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: workDir,
      allowFailure: true,
    });
    if (r.code === 0) return true;
  }
  return false;
}

/** The task began (status flipped, sentinel written) but prompt building threw: undo both. */
async function rollbackBegun(taskId: string, task: TaskSpec, worktreePath: string): Promise<void> {
  try {
    const file = findTaskFile(taskId, worktreePath);
    if (file) {
      writeFileSync(
        file,
        patchFrontmatterStatus(readFileSync(file, 'utf8'), statusOf(task)),
        'utf8',
      );
    }
  } catch {
    // best effort; the sentinel removal below is the load-bearing part
  }
  try {
    await cleanupTask({ taskId, worktreePath });
  } catch {
    // best effort
  }
}
