/**
 * Rollback helper for failed dispatches (AISDLC-177).
 *
 * Witness (2026-05-03/04): the orchestrator dispatched AISDLC-70, Step 4
 * flipped status to "In Progress" and wrote the per-worktree
 * `.active-task` sentinel, then Step 6 failed with `outcome:
 * "developer-failed"`. The orchestrator recorded the failure and exited —
 * leaving:
 *   - task status stuck at "In Progress" (was "To Do")
 *   - `.worktrees/<task-id>/` left on disk with a stale branch
 *   - `.active-task` sentinel still present
 *   - any commits the dev produced stranded on a branch nobody owned
 *
 * Operator had to manually `git worktree remove --force`, edit the task
 * file to revert status, delete the sentinel, and (in the AISDLC-70 case)
 * recover a valid commit before it was reaped.
 *
 * This module owns the inverse of those four side-effects:
 *   1. Revert task status to its pre-dispatch value via the same
 *      frontmatter-patching helper Step 4 used (no MCP-tool dependency
 *      from inside the orchestrator).
 *   2. Optionally rename the dev's branch under `quarantine/<id>-<ts>`
 *      when it carries commits beyond `origin/main` so the work isn't
 *      destroyed.
 *   3. Remove the worktree via `git worktree remove --force`. The
 *      sentinel goes with it.
 *   4. Return a structured `RollbackResult` so the caller can mint
 *      `OrchestratorRollback` + `OrchestratorWorkQuarantined` events.
 *
 * Pure adapter pattern: every side-effect goes through the injected
 * `Runner` so tests can drive the helper without touching the real git
 * tree.
 *
 * @module orchestrator/rollback
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { defaultRunner, type Runner } from '../runtime/exec.js';
import { findTaskFile } from '../steps/01-validate.js';
import { patchFrontmatterStatus } from '../steps/04-flip-status.js';
import { DEFAULT_LOGGER, type PipelineLogger } from '../types.js';

export interface RollbackOptions {
  /** Project root (where backlog/ + .worktrees/ live). */
  workDir: string;
  /** Canonical task ID (e.g. `AISDLC-70`). */
  taskId: string;
  /** Status the orchestrator captured BEFORE Step 4 flipped to In Progress. */
  fromStatus: string;
  /** Worktree path Step 3 created (e.g. `<workDir>/.worktrees/aisdlc-70`). */
  worktreePath: string;
  /** Branch name Step 2 computed (e.g. `ai-sdlc/aisdlc-70-rollback-task`). */
  branch: string;
  /** Injected runner — tests stub git/gh; production uses defaultRunner. */
  runner?: Runner;
  /** Optional logger — defaults to console. */
  logger?: PipelineLogger;
  /** Wall-clock for the quarantine ref's timestamp suffix. Tests inject. */
  now?: () => Date;
}

export interface RollbackResult {
  /** Task ID for callsite ergonomics. */
  taskId: string;
  /** Status value the helper attempted to revert TO. */
  fromStatus: string;
  /** True when the task file's `status:` line was successfully patched. */
  statusReverted: boolean;
  /** True when `git worktree remove --force <path>` succeeded. */
  worktreeRemoved: boolean;
  /** True when the dev's branch had commits we preserved as a quarantine ref. */
  branchQuarantined: boolean;
  /** Quarantine ref name; set when `branchQuarantined`. */
  quarantineRef?: string;
  /** Tip SHA preserved under the quarantine ref; set when `branchQuarantined`. */
  quarantineSha?: string;
  /** Number of commits beyond origin/main we preserved; set when `branchQuarantined`. */
  quarantineCommitCount?: number;
  /** Best-effort error log accumulated across the four steps. Empty on full success. */
  warnings: string[];
}

/**
 * Build the quarantine ref name from a task ID + a Date.
 *
 * Format: `quarantine/<task-id-lower>-<YYYY-MM-DDTHH-MM-SS-mmm>`. Colons
 * are not legal in git ref names so we substitute hyphens; the rest of
 * ISO 8601 is ref-safe.
 *
 * AISDLC-186 — bumped from second-precision to millisecond-precision.
 * The previous format (`YYYY-MM-DDTHH-MM-SS`) collided when two
 * rollbacks fired for the same task in the same UTC second — the second
 * `git branch -m` failed (rename-fails-if-exists semantics), surfaced
 * only as a logged warning, and the second attempt's commits became
 * eligible for the throwaway-branch `branch -D` cleanup at the bottom
 * of `rollbackDispatch()`. Production probability was low but the
 * failure mode was silent + data-losing. Millisecond precision makes
 * the collision window 1000x narrower without changing any consumer
 * contract (git refs accept the longer name, the operator runbook's
 * `git branch --list 'quarantine/*'` still works, old refs co-exist
 * with the new format).
 *
 * Exported for unit testing + so callers building related rollback
 * tooling can derive the same ref name.
 */
export function buildQuarantineRef(taskId: string, when: Date): string {
  const iso = when.toISOString();
  // Strip the trailing `Z`, then swap colons + the millisecond `.` for
  // hyphens. 2026-05-04T14:23:44.123Z → 2026-05-04T14-23-44-123
  const stamp = iso.replace(/Z$/, '').replace(/[:.]/g, '-');
  return `quarantine/${taskId.toLowerCase()}-${stamp}`;
}

/**
 * Roll back the side-effects Step 4 (status flip + sentinel) and Step 3
 * (worktree creation) introduced for a dispatch that subsequently
 * failed. Idempotent: every step is wrapped in its own try/catch so a
 * partial failure (e.g. the worktree was already removed by an operator)
 * doesn't crash the whole rollback — warnings accumulate in the result.
 *
 * Pre-dispatch status is captured by the orchestrator BEFORE Step 4
 * runs; this helper takes it as a parameter rather than re-reading the
 * task file (which now carries "In Progress" thanks to Step 4).
 */
export async function rollbackDispatch(opts: RollbackOptions): Promise<RollbackResult> {
  const runner = opts.runner ?? defaultRunner;
  const logger = opts.logger ?? DEFAULT_LOGGER;
  const now = opts.now ?? ((): Date => new Date());
  const warnings: string[] = [];

  // ── 1. Revert task status ──────────────────────────────────────────
  let statusReverted = false;
  try {
    const taskFile = findTaskFile(opts.taskId, opts.workDir);
    if (!taskFile) {
      warnings.push(`task file not found for ${opts.taskId}`);
    } else if (!existsSync(taskFile)) {
      warnings.push(`task file disappeared at ${taskFile}`);
    } else {
      const raw = readFileSync(taskFile, 'utf8');
      const patched = patchFrontmatterStatus(raw, opts.fromStatus);
      writeFileSync(taskFile, patched, 'utf8');
      statusReverted = true;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`status revert failed: ${reason}`);
    logger.warn(`[orchestrator-rollback] status revert failed for ${opts.taskId}: ${reason}`);
  }

  // ── 2. Quarantine the branch IF it carries commits ────────────────
  // We do this BEFORE removing the worktree so we still have a working
  // git tree to query commit counts against. The branch lives in the
  // parent repo's ref namespace, not the worktree's, so the worktree
  // removal that follows doesn't touch it.
  let branchQuarantined = false;
  let quarantineRef: string | undefined;
  let quarantineSha: string | undefined;
  let quarantineCommitCount: number | undefined;
  try {
    const ahead = await countCommitsAhead(runner, opts.workDir, opts.branch);
    if (ahead && ahead.count > 0) {
      const ref = buildQuarantineRef(opts.taskId, now());
      // `git branch -m <old> <new>` renames in place. The ref must not
      // already exist — the millisecond-precision timestamp suffix
      // (AISDLC-186) makes collisions vanishingly unlikely (would
      // require two rollbacks for the same task within the same UTC
      // millisecond) but we surface any failure as a warning rather
      // than throwing.
      const renamed = await runner('git', ['branch', '-m', opts.branch, ref], {
        cwd: opts.workDir,
        allowFailure: true,
      });
      if (renamed.code === 0) {
        branchQuarantined = true;
        quarantineRef = ref;
        quarantineSha = ahead.tipSha;
        quarantineCommitCount = ahead.count;
      } else {
        const reason = (renamed.stderr || renamed.stdout).trim();
        warnings.push(`quarantine rename failed: ${reason}`);
        logger.warn(
          `[orchestrator-rollback] quarantine rename failed for ${opts.taskId} (${opts.branch} → ${ref}): ${reason}`,
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`quarantine probe failed: ${reason}`);
    logger.warn(`[orchestrator-rollback] quarantine probe failed for ${opts.taskId}: ${reason}`);
  }

  // ── 3. Remove the worktree (sentinel goes with it) ────────────────
  let worktreeRemoved = false;
  try {
    if (!existsSync(opts.worktreePath)) {
      // Nothing to remove — count it as success (idempotent).
      worktreeRemoved = true;
    } else {
      const removed = await runner('git', ['worktree', 'remove', '--force', opts.worktreePath], {
        cwd: opts.workDir,
        allowFailure: true,
      });
      if (removed.code === 0) {
        worktreeRemoved = true;
      } else {
        const reason = (removed.stderr || removed.stdout).trim();
        warnings.push(`worktree remove failed: ${reason}`);
        logger.warn(
          `[orchestrator-rollback] worktree remove failed for ${opts.taskId} (${opts.worktreePath}): ${reason}`,
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`worktree remove threw: ${reason}`);
    logger.warn(`[orchestrator-rollback] worktree remove threw for ${opts.taskId}: ${reason}`);
  }

  // ── 4. Best-effort delete of the original branch when NOT quarantined ─
  // If the dev produced no commits we still want the throwaway branch
  // gone so a re-dispatch can recreate it cleanly. When quarantined the
  // rename already moved the ref; nothing further to do.
  if (!branchQuarantined) {
    try {
      await runner('git', ['branch', '-D', opts.branch], {
        cwd: opts.workDir,
        allowFailure: true,
      });
    } catch {
      // Branch may not exist (worktree removal sometimes prunes it);
      // best-effort cleanup, no warning.
    }
  }

  return {
    taskId: opts.taskId,
    fromStatus: opts.fromStatus,
    statusReverted,
    worktreeRemoved,
    branchQuarantined,
    ...(quarantineRef !== undefined ? { quarantineRef } : {}),
    ...(quarantineSha !== undefined ? { quarantineSha } : {}),
    ...(quarantineCommitCount !== undefined ? { quarantineCommitCount } : {}),
    warnings,
  };
}

/**
 * Probe whether a branch has any commits beyond `origin/main`. Returns
 * `{ count, tipSha }` when it does, `null` otherwise. Best-effort: any
 * failure (branch missing, no upstream, runner threw) returns `null` so
 * the caller skips quarantine rather than crashing the rollback.
 *
 * Uses `git rev-list <branch> ^origin/main --count` for the ahead count
 * and `git rev-parse <branch>` for the tip SHA. Both are cheap (no
 * working-tree access).
 */
async function countCommitsAhead(
  runner: Runner,
  workDir: string,
  branch: string,
): Promise<{ count: number; tipSha: string } | null> {
  // First verify the branch even exists in the parent repo's ref
  // namespace. `git rev-parse --verify` exits non-zero when the ref is
  // missing — that's the common case after a Step 3 worktree removal
  // that took the branch with it (a worktree on the same branch).
  const verify = await runner('git', ['rev-parse', '--verify', branch], {
    cwd: workDir,
    allowFailure: true,
  });
  if (verify.code !== 0) return null;
  const tipSha = verify.stdout.trim();
  if (!tipSha) return null;

  // Count commits on <branch> not reachable from origin/main. Falls
  // back to counting against `main` (no `origin/`) if the upstream ref
  // isn't present (test fixtures, fresh init repos).
  const upstream =
    (
      await runner('git', ['rev-parse', '--verify', 'origin/main'], {
        cwd: workDir,
        allowFailure: true,
      })
    ).code === 0
      ? 'origin/main'
      : 'main';
  const counted = await runner('git', ['rev-list', '--count', branch, `^${upstream}`], {
    cwd: workDir,
    allowFailure: true,
  });
  if (counted.code !== 0) return null;
  const count = Number.parseInt(counted.stdout.trim(), 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count, tipSha };
}
