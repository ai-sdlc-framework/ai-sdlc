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
 *      destroyed — guarded by `isReallyStale()` (AISDLC-228) so an
 *      active branch is never quarantined mid-flight.
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

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /**
   * AISDLC-228 — override the sentinel mtime reader for hermetic tests.
   * When undefined the real `fs.statSync().mtimeMs` is used.
   * Returns the mtime in milliseconds since epoch, or null if missing.
   */
  readSentinelMtime?: (sentinelPath: string) => number | null;
  /**
   * AISDLC-228 — override the process-table scanner for hermetic tests.
   * Returns the raw stdout of `ps -ax -o pid,command`, or throws.
   */
  readProcessTable?: () => string;
  /**
   * AISDLC-228 — override `Date.now()` for hermetic sentinel-age tests.
   */
  nowMs?: () => number;
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
  /**
   * AISDLC-228 — set when `isReallyStale()` determined the branch was NOT stale
   * and quarantine was skipped to protect in-flight work. Human-readable reason
   * naming the preserving signal (e.g. `"active sentinel modified 12min ago"`).
   */
  quarantineSkippedReason?: string;
  /** Best-effort error log accumulated across the four steps. Empty on full success. */
  warnings: string[];
}

// ── AISDLC-228 — isReallyStale predicate ────────────────────────────────────

/** Six-hour sentinel age threshold (in ms). Sentinels younger than this mean "active". */
const SENTINEL_ACTIVE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Exported for hermetic tests. Returns sentinel mtime in ms, or null when missing/error.
 */
export function defaultReadSentinelMtime(sentinelPath: string): number | null {
  try {
    return statSync(sentinelPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Exported for hermetic tests. Returns raw `ps -ax -o pid,command` stdout, or throws.
 */
export function defaultReadProcessTable(): string {
  return execSync('ps -ax -o pid,command', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Scan the process table for a `claude --print` or `claude -p` subprocess
 * whose argv contains the task ID. Returns the PID if found, null otherwise.
 *
 * Mirrors the logic in `filters/already-in-flight.ts` so both guards use
 * the same detection heuristic.
 */
function findClaudeSubprocess(psOutput: string, taskId: string): number | null {
  const taskIdLower = taskId.toLowerCase();
  const taskIdUpper = taskId.toUpperCase();
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx).trim();
    const command = trimmed.slice(spaceIdx + 1).trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue;
    if (!command.includes('claude')) continue;
    if (!command.includes('--print') && !/ -p(\s|$)/.test(command)) continue;
    if (command.includes(taskIdLower) || command.includes(taskIdUpper)) {
      return pid;
    }
  }
  return null;
}

/**
 * AISDLC-228 — Determine whether a branch with commits ahead of origin/main
 * is TRULY stale (safe to quarantine) vs actively in-flight (must be preserved).
 *
 * Returns `{ stale: false, reason }` when ANY single signal says "in-flight".
 * Returns `{ stale: true }` only when ALL four signals are quiet.
 *
 * The four signals:
 * 1. **Unpushed commits on an upstream branch** — when the branch has a
 *    tracking remote AND is ahead of that remote (not just ahead of
 *    origin/main), those commits are already being pushed and must not be
 *    clobbered. When there's NO upstream the branch is local-only, which
 *    is still a "not stale" signal because the dev may be mid-push.
 * 2. **Active `.active-task` sentinel** — `<worktree>/.active-task` modified
 *    within the last 6 hours. A fresh sentinel means a live session is using
 *    this worktree right now.
 * 3. **Live `claude --print` subprocess** — a `claude --print` (or `-p`)
 *    process whose argv contains the task ID is running in the OS process
 *    table. Best-effort; silently skipped on ps errors.
 * 4. **Open GitHub PR** — `gh pr list --head <branch> --state open` returns
 *    ≥1 entry. An open PR means commits are in review; quarantining would
 *    break the PR's source ref.
 *
 * Async to allow the gh PR check (network call via Runner, not execSync).
 * The caller (rollbackDispatch) wraps this in its own try/catch so any
 * unexpected failure falls through to the conservative "stale" verdict
 * (since we're checking after countCommitsAhead already found commits,
 * defaulting to quarantine on error is acceptable — it's the same
 * behaviour as before AISDLC-228).
 *
 * Exported for hermetic tests.
 */
export async function isReallyStale(
  taskId: string,
  branch: string,
  workDir: string,
  worktreePath: string,
  opts: {
    runner: Runner;
    readSentinelMtime?: (path: string) => number | null;
    readProcessTable?: () => string;
    nowMs?: () => number;
  },
): Promise<{ stale: boolean; reason?: string }> {
  const nowMs = opts.nowMs ?? ((): number => Date.now());
  const readSentinelMtime = opts.readSentinelMtime ?? defaultReadSentinelMtime;
  const readProcessTable = opts.readProcessTable ?? defaultReadProcessTable;

  // Signal 1 — upstream tracking branch: if the branch has an upstream
  // AND is ahead of it, commits are in-flight (being pushed).
  // If the branch has NO upstream, it's local-only — still not stale because
  // the dev may be mid-push. We detect the upstream via
  // `git rev-parse --abbrev-ref <branch>@{upstream}`.
  const upstreamResult = await opts.runner(
    'git',
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    { cwd: workDir, allowFailure: true },
  );
  if (upstreamResult.code === 0) {
    const upstream = upstreamResult.stdout.trim();
    if (upstream) {
      // Branch has a remote tracking ref — check if it's ahead of it.
      const aheadResult = await opts.runner(
        'git',
        ['rev-list', '--count', branch, `^${upstream}`],
        { cwd: workDir, allowFailure: true },
      );
      if (aheadResult.code === 0) {
        const count = Number.parseInt(aheadResult.stdout.trim(), 10);
        if (Number.isFinite(count) && count > 0) {
          return {
            stale: false,
            reason: `${count} commit${count === 1 ? '' : 's'} ahead of ${upstream} (unpushed)`,
          };
        }
      }
    }
  } else {
    // No upstream — branch is local-only; treat as not stale (dev may be mid-push).
    // We only skip this "no-upstream → not-stale" signal when we can confirm
    // the branch is fully merged (countCommitsAhead = 0), but by this point
    // we know countCommitsAhead > 0, so local-only + commits = not stale.
    return {
      stale: false,
      reason: `branch has no remote upstream and has unpushed commits`,
    };
  }

  // Signal 2 — active sentinel age.
  const sentinelPath = join(worktreePath, '.active-task');
  const mtime = readSentinelMtime(sentinelPath);
  if (mtime !== null) {
    const ageMs = nowMs() - mtime;
    if (ageMs < SENTINEL_ACTIVE_THRESHOLD_MS) {
      const ageMins = Math.round(ageMs / 60_000);
      return {
        stale: false,
        reason: `active sentinel modified ${ageMins}min ago`,
      };
    }
  }

  // Signal 3 — live claude subprocess.
  try {
    const psOutput = readProcessTable();
    const pid = findClaudeSubprocess(psOutput, taskId);
    if (pid !== null) {
      return {
        stale: false,
        reason: `live claude --print subprocess for ${taskId} (PID ${pid})`,
      };
    }
  } catch {
    // ps not available or parse error — skip this signal.
  }

  // Signal 4 — open GitHub PR.
  // CRITICAL: fail CLOSED on any non-zero gh exit — same as isSafeToAutoClean.
  const prResult = await opts.runner(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'],
    { cwd: workDir, allowFailure: true },
  );
  if (prResult.code !== 0) {
    // gh failed — conservatively treat as "in-flight" (safe side).
    return { stale: false, reason: 'gh pr list failed; treating as in-flight (fail-closed)' };
  }
  try {
    const parsed = JSON.parse(prResult.stdout.trim() || '[]') as unknown[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0] as { number?: number };
      const prNum = typeof first.number === 'number' ? `#${first.number}` : 'unknown';
      return { stale: false, reason: `open PR ${prNum} for branch ${branch}` };
    }
  } catch {
    // Non-JSON response — conservatively treat as "in-flight".
    if (prResult.stdout.trim().length > 0) {
      return { stale: false, reason: 'gh pr list returned non-JSON; treating as in-flight' };
    }
  }

  return { stale: true };
}

// ── End AISDLC-228 ──────────────────────────────────────────────────────────

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

  // ── 2. Quarantine the branch IF it carries commits AND is truly stale ───
  // AISDLC-228: guard the quarantine rename behind isReallyStale() so we
  // never clobber a branch that is actively in-flight. We check BEFORE
  // removing the worktree so we still have a working git tree to query.
  // The branch lives in the parent repo's ref namespace, not the worktree's,
  // so the worktree removal that follows doesn't touch it.
  let branchQuarantined = false;
  let quarantineRef: string | undefined;
  let quarantineSha: string | undefined;
  let quarantineCommitCount: number | undefined;
  let quarantineSkippedReason: string | undefined;
  try {
    const ahead = await countCommitsAhead(runner, opts.workDir, opts.branch);
    if (ahead && ahead.count > 0) {
      // AISDLC-228 — before renaming, verify the branch is truly stale.
      // Any single "in-flight" signal preserves the branch.
      const staleCheck = await isReallyStale(
        opts.taskId,
        opts.branch,
        opts.workDir,
        opts.worktreePath,
        {
          runner,
          readSentinelMtime: opts.readSentinelMtime,
          readProcessTable: opts.readProcessTable,
          nowMs: opts.nowMs,
        },
      );

      if (!staleCheck.stale) {
        // Branch is in-flight — skip quarantine and log a trace line.
        quarantineSkippedReason = staleCheck.reason;
        const taskIdLower = opts.taskId.toLowerCase();
        logger.info(
          `[step-3] ${taskIdLower}: keeping branch (${staleCheck.reason ?? 'in-flight signal detected'})`,
        );
      } else {
        // Branch is truly stale — proceed with the quarantine rename.
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
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`quarantine probe failed: ${reason}`);
    logger.warn(`[orchestrator-rollback] quarantine probe failed for ${opts.taskId}: ${reason}`);
  }

  // ── 3. Remove the worktree (sentinel goes with it) ────────────────
  // AISDLC-228 — when quarantine was skipped (branch is in-flight), also
  // skip the worktree removal. Removing the worktree mid-flight would
  // destroy the operator's session — exactly the incident this task fixes.
  let worktreeRemoved = false;
  if (quarantineSkippedReason !== undefined) {
    // Branch is in-flight — do NOT remove the worktree.
    worktreeRemoved = false;
  } else {
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
  }

  // ── 4. Best-effort delete of the original branch when NOT quarantined ─
  // If the dev produced no commits we still want the throwaway branch
  // gone so a re-dispatch can recreate it cleanly. When quarantined the
  // rename already moved the ref; nothing further to do.
  // AISDLC-228 — when quarantine was SKIPPED because the branch is
  // in-flight, also skip the branch delete (same reason: not stale).
  if (!branchQuarantined && quarantineSkippedReason === undefined) {
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
    ...(quarantineSkippedReason !== undefined ? { quarantineSkippedReason } : {}),
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
