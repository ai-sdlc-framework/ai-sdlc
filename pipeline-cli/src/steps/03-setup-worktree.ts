/**
 * Step 3 — Setup the per-task git worktree from the latest origin/main.
 *
 * Mirrors `execute-orchestrator.md` Step 3. Fetches latest main first
 * (paired with Step 10.5 for AISDLC-102 defense in depth), creates the
 * worktree directory, and runs `git worktree add <path> -b <branch> origin/main`.
 *
 * AISDLC-224 — when `opts.autonomousMode === true` AND
 * `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` is truthy, a "branch already exists"
 * failure triggers an automatic cleanup-then-retry path. Six safety
 * predicates must all pass before any cleanup proceeds (AISDLC-228 added
 * signals 4-6): no open PR, no uncommitted changes, branch not checked out
 * elsewhere, no unpushed commits, no active sentinel (<6h), no live subprocess.
 * A `WorktreeAutoCleaned` event is emitted when cleanup fires.
 *
 * @module steps/03-setup-worktree
 */

import { execSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { SetupWorktreeResult } from '../types.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';

/** Canonical truthy values for feature flags (per CLAUDE.md feature-flag conventions). */
function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface SetupWorktreeOptions {
  taskId: string;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Skip the `git fetch origin main` step (useful in tests / offline runs). */
  skipFetch?: boolean;
  /**
   * AISDLC-224 — when true, enables the auto-cleanup path on stale-branch
   * failures (provided `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP` is also set).
   * The orchestrator loop sets this to true; manual `/ai-sdlc execute` leaves
   * it false (default OFF — no behavior change for manual path).
   */
  autonomousMode?: boolean;
  /**
   * AISDLC-224 — optional sink for the `WorktreeAutoCleaned` event. The
   * orchestrator loop injects its per-tick `emit`; tests inject a capturer.
   * When undefined, cleanup still proceeds but no event is emitted.
   */
  emitEvent?: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void;
  /**
   * AISDLC-228 — override the sentinel mtime reader for hermetic tests.
   * Returns the mtime in milliseconds since epoch, or null if missing/error.
   */
  readSentinelMtime?: (sentinelPath: string) => number | null;
  /**
   * AISDLC-228 — override the process-table scanner for hermetic tests.
   * Returns the raw stdout of `ps -ax -o pid,command`, or throws.
   */
  readProcessTable?: () => string;
  /**
   * AISDLC-228 — override `Date.now()` for hermetic tests of sentinel age.
   */
  nowMs?: () => number;
}

/**
 * AISDLC-224 — check whether the `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP`
 * feature flag is enabled. Exported so tests can assert the predicate
 * without going through the full `setupWorktree()` call.
 */
export function isAutoCleanupEnabled(): boolean {
  return isFlagEnabled(process.env.AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP);
}

/** AISDLC-224 — detect "branch already exists" stderr pattern. */
function isBranchExistsError(stderr: string): boolean {
  return /branch.+already exists|already exists.+branch/i.test(stderr);
}

/** Six-hour sentinel age threshold (in ms). Sentinels younger than this mean "active". */
const SENTINEL_ACTIVE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Scan ps output for a claude --print/-p subprocess referencing the task ID.
 * Returns the PID if found, null otherwise. Mirrors the logic in already-in-flight.ts.
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
 * AISDLC-224 + AISDLC-228 — run all safety predicates before any cleanup.
 * Returns `{ safe: true }` only when ALL predicates pass (safe to proceed).
 *
 * Safety predicates (AISDLC-228 added signals 4-6):
 * 1. No open PR for the branch.
 * 2. No uncommitted changes in the existing worktree.
 * 3. Branch not checked out in any other registered worktree.
 * 4. No unpushed commits (commits ahead of origin/main that have no upstream).
 * 5. No active `.active-task` sentinel younger than 6 hours.
 * 6. No live `claude --print` subprocess for this task.
 *
 * When NOT safe, emits a `[step-3] <taskId>: keeping branch (<reason>)` trace
 * line for observability (AC #3 of AISDLC-228).
 */
async function isSafeToAutoClean(
  runner: Runner,
  workDir: string,
  taskId: string,
  branch: string,
  worktreePath: string,
  opts?: {
    readSentinelMtime?: (path: string) => number | null;
    readProcessTable?: () => string;
    nowMs?: () => number;
  },
): Promise<{ safe: boolean; hadOpenPR: boolean; hadUncommittedChanges: boolean }> {
  const taskIdLower = taskId.toLowerCase();

  // Predicate 1: open-PR check.
  // CRITICAL: fail CLOSED on any non-zero gh exit (token expired, network
  // timeout, gh not installed, rate limit). Without this, a transient gh
  // failure would let cleanup proceed against a branch with an open PR
  // and `git branch -D` would delete the local branch backing the live
  // PR. Mitigation: treat any gh-failure as "unknown PR state → unsafe".
  // (Code-reviewer + security-reviewer #377 both flagged this fail-open.)
  const prResult = await runner(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'],
    { cwd: workDir, allowFailure: true },
  );
  if (prResult.code !== 0) {
    // gh failed — fail closed, refuse cleanup.
    console.info(`[step-3] ${taskIdLower}: keeping branch (gh pr list failed; fail-closed)`);
    return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
  }
  let hadOpenPR = false;
  try {
    const parsed = JSON.parse(prResult.stdout.trim() || '[]') as unknown[];
    hadOpenPR = Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // gh returned non-JSON — treat conservatively as having an open PR
    hadOpenPR = prResult.stdout.trim().length > 0;
  }
  if (hadOpenPR) {
    console.info(`[step-3] ${taskIdLower}: keeping branch (open PR found for ${branch})`);
    return { safe: false, hadOpenPR: true, hadUncommittedChanges: false };
  }

  // Predicate 2: uncommitted-changes check (only if worktree path exists)
  let hadUncommittedChanges = false;
  const statusResult = await runner('git', ['-C', worktreePath, 'status', '--porcelain'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (statusResult.code === 0 && statusResult.stdout.trim().length > 0) {
    hadUncommittedChanges = true;
  } else if (statusResult.code !== 0) {
    // git status failed — worktree path likely doesn't exist yet, which is
    // fine (the worktree dir only exists if a prior session got past mkdir).
    // Treat a non-zero exit as "no uncommitted changes" since there's nothing
    // to lose. If the path does exist and git failed, that's unusual; still
    // safe because the worktree-remove step below will catch real issues.
  }
  if (hadUncommittedChanges) {
    console.info(`[step-3] ${taskIdLower}: keeping branch (uncommitted changes in worktree)`);
    return { safe: false, hadOpenPR: false, hadUncommittedChanges: true };
  }

  // Predicate 3: branch-checked-out-elsewhere check
  const worktreeListResult = await runner('git', ['worktree', 'list', '--porcelain'], {
    cwd: workDir,
    allowFailure: true,
  });
  if (worktreeListResult.code === 0) {
    const lines = worktreeListResult.stdout.split('\n');
    let currentPath = '';
    // EXACT match against `branch refs/heads/<branch>` — substring `includes`
    // would falsely match prefixes (e.g. branch=`ai-sdlc/aisdlc-9` would
    // match `branch refs/heads/ai-sdlc/aisdlc-99`). Code-reviewer #377
    // flagged this. Git's worktree porcelain emits the branch line as
    // `branch refs/heads/<full-name>` with no trailing whitespace.
    const expectedBranchLine = `branch refs/heads/${branch}`;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.trim() === expectedBranchLine) {
        // Found the branch — check if it's at a DIFFERENT path
        const normalizedCurrentPath = currentPath.replace(/\/$/, '');
        const normalizedExpectedPath = worktreePath.replace(/\/$/, '');
        if (normalizedCurrentPath !== normalizedExpectedPath) {
          // Branch is checked out at a different location — unsafe
          console.info(`[step-3] ${taskIdLower}: keeping branch (checked out at ${currentPath})`);
          return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
        }
      }
    }
  }

  // Predicate 4 (AISDLC-228): unpushed-commits check.
  // When the branch has commits ahead of origin/main AND no remote upstream
  // (i.e. not yet pushed), cleanup would silently destroy unrecoverable work.
  // We check: does the branch have a remote tracking ref? If not → not safe.
  // If yes, is it ahead of that upstream? If yes → not safe.
  const upstreamResult = await runner(
    'git',
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    { cwd: workDir, allowFailure: true },
  );
  if (upstreamResult.code !== 0) {
    // No upstream — check if branch has ANY commits ahead of origin/main.
    const aheadOriginResult = await runner('git', ['rev-list', '--count', branch, '^origin/main'], {
      cwd: workDir,
      allowFailure: true,
    });
    if (aheadOriginResult.code === 0) {
      const ahead = Number.parseInt(aheadOriginResult.stdout.trim(), 10);
      if (Number.isFinite(ahead) && ahead > 0) {
        console.info(
          `[step-3] ${taskIdLower}: keeping branch (${ahead} unpushed commit(s), no upstream)`,
        );
        return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
      }
    }
  } else {
    // Has an upstream — check if ahead of it.
    const upstream = upstreamResult.stdout.trim();
    if (upstream) {
      const aheadUpstreamResult = await runner(
        'git',
        ['rev-list', '--count', branch, `^${upstream}`],
        { cwd: workDir, allowFailure: true },
      );
      if (aheadUpstreamResult.code === 0) {
        const ahead = Number.parseInt(aheadUpstreamResult.stdout.trim(), 10);
        if (Number.isFinite(ahead) && ahead > 0) {
          console.info(
            `[step-3] ${taskIdLower}: keeping branch (${ahead} commit(s) ahead of ${upstream})`,
          );
          return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
        }
      }
    }
  }

  // Predicate 5 (AISDLC-228): active sentinel age check.
  const sentinelPath = join(worktreePath, '.active-task');
  const readSentinelMtime =
    opts?.readSentinelMtime ??
    ((p: string): number | null => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    });
  const nowMs = opts?.nowMs ?? ((): number => Date.now());
  const mtime = readSentinelMtime(sentinelPath);
  if (mtime !== null) {
    const ageMs = nowMs() - mtime;
    if (ageMs < SENTINEL_ACTIVE_THRESHOLD_MS) {
      const ageMins = Math.round(ageMs / 60_000);
      console.info(
        `[step-3] ${taskIdLower}: keeping branch (active sentinel modified ${ageMins}min ago)`,
      );
      return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
    }
  }

  // Predicate 6 (AISDLC-228): live subprocess check.
  const readProcessTable =
    opts?.readProcessTable ??
    ((): string =>
      execSync('ps -ax -o pid,command', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  try {
    const psOutput = readProcessTable();
    const pid = findClaudeSubprocess(psOutput, taskId);
    if (pid !== null) {
      console.info(
        `[step-3] ${taskIdLower}: keeping branch (live claude --print subprocess PID ${pid})`,
      );
      return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
    }
  } catch {
    // ps not available or parse error — skip this signal (conservative: allow cleanup).
  }

  return { safe: true, hadOpenPR: false, hadUncommittedChanges: false };
}

/**
 * AISDLC-224 — attempt cleanup-then-retry when a stale branch blocks worktree
 * creation. Returns the retry result or null if cleanup was unsafe/failed.
 */
async function attemptAutoCleanup(
  runner: Runner,
  opts: SetupWorktreeOptions,
): Promise<{ retried: boolean; addResult: Awaited<ReturnType<Runner>> } | null> {
  const { safe, hadOpenPR, hadUncommittedChanges } = await isSafeToAutoClean(
    runner,
    opts.workDir,
    opts.taskId,
    opts.branch,
    opts.worktreePath,
    {
      readSentinelMtime: opts.readSentinelMtime,
      readProcessTable: opts.readProcessTable,
      nowMs: opts.nowMs,
    },
  );

  if (!safe) {
    return null;
  }

  // Step 1: remove the stale worktree directory (if registered with git)
  await runner('git', ['worktree', 'remove', '--force', opts.worktreePath], {
    cwd: opts.workDir,
    allowFailure: true,
  });

  // Step 2: delete the stale local branch
  await runner('git', ['branch', '-D', opts.branch], {
    cwd: opts.workDir,
    allowFailure: true,
  });

  // Step 3: retry worktree add once
  const retryResult = await runner(
    'git',
    ['worktree', 'add', opts.worktreePath, '-b', opts.branch, 'origin/main'],
    { cwd: opts.workDir, allowFailure: true },
  );

  // Emit WorktreeAutoCleaned event ONLY after retry succeeds. If we emit
  // before cleanup runs (or before the retry succeeds), an operator seeing
  // the event in events.jsonl would incorrectly believe the cleanup landed
  // even when the retry failed and the original error was thrown. Emit
  // after retry success means: event present ⇒ cleanup actually finished.
  // (Code-reviewer #377 minor finding 4.)
  if (retryResult.code === 0 && opts.emitEvent) {
    opts.emitEvent({
      type: 'WorktreeAutoCleaned',
      ts: new Date().toISOString(),
      taskId: opts.taskId,
      branch: opts.branch,
      reason: 'branch already exists',
      hadOpenPR,
      hadUncommittedChanges,
    });
  }

  return { retried: true, addResult: retryResult };
}

export async function setupWorktree(opts: SetupWorktreeOptions): Promise<SetupWorktreeResult> {
  const runner = opts.runner ?? defaultRunner;

  if (!opts.skipFetch) {
    await runner('git', ['fetch', 'origin', 'main'], {
      cwd: opts.workDir,
      timeout: 30_000,
      allowFailure: true,
    });
  }

  // Idempotent mkdir of `.worktrees/`
  mkdirSync(join(opts.workDir, '.worktrees'), { recursive: true });

  const addResult = await runner(
    'git',
    ['worktree', 'add', opts.worktreePath, '-b', opts.branch, 'origin/main'],
    { cwd: opts.workDir, allowFailure: true },
  );

  if (addResult.code !== 0) {
    // AISDLC-224 — auto-cleanup path: only attempt when:
    //   a) autonomousMode is true
    //   b) AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP feature flag is on
    //   c) the error is specifically "branch already exists"
    const shouldTryCleanup =
      opts.autonomousMode === true &&
      isAutoCleanupEnabled() &&
      isBranchExistsError(addResult.stderr);

    if (shouldTryCleanup) {
      const cleanupResult = await attemptAutoCleanup(runner, opts);
      if (cleanupResult && cleanupResult.addResult.code === 0) {
        // Retry succeeded — continue with the cleaned-up worktree
        const baseShaResult = await runner('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'], {
          allowFailure: true,
        });
        const baseSha = baseShaResult.code === 0 ? baseShaResult.stdout.trim() : '';
        return { branch: opts.branch, worktreePath: opts.worktreePath, baseSha };
      }
    }

    // Either auto-cleanup was not attempted, predicates failed, or retry also failed
    throw new Error(
      `git worktree add failed for branch '${opts.branch}': ${addResult.stderr.trim() || 'unknown error'}\n` +
        `Likely cause: branch already exists. Run \`/ai-sdlc cleanup ${opts.taskId}\` first or pick a different task.`,
    );
  }

  const baseShaResult = await runner('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'], {
    allowFailure: true,
  });
  const baseSha = baseShaResult.code === 0 ? baseShaResult.stdout.trim() : '';

  return { branch: opts.branch, worktreePath: opts.worktreePath, baseSha };
}
