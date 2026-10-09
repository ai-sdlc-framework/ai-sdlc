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
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { checkOwnWorktreeForOperator } from '../hierarchy/lease-policy.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { withWorktreeMutex, type WithWorktreeMutexOptions } from '../runtime/worktree-mutex.js';
import type { SetupWorktreeResult } from '../types.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import { ensureWorktreeHooks, type HooksCheckFs } from './hooks-check.js';

/** Canonical truthy values for feature flags (per CLAUDE.md feature-flag conventions). */
function isFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface SetupWorktreeOptions {
  /**
   * AISDLC-770 — `--task-from-file` path. The file is not on main, so the
   * fresh `origin/main` worktree does not hold it; Step 3 copies it to
   * `<worktree>/backlog/tasks/<basename>` (no-op when already there).
   */
  taskFilePathOverride?: string;
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
  /**
   * AISDLC-241 — options forwarded to `withWorktreeMutex()`. When provided,
   * `git worktree add`, `git worktree remove`, and `git branch -D` are
   * serialized via the in-process mutex (and optionally the file-based lock).
   *
   * The orchestrator loop injects `{ workDir }` so all concurrent ticks in
   * the same process share the singleton queue. Tests inject `{ _mutex }`
   * to drive a private mutex without touching the global one.
   *
   * When undefined (the default), no locking is applied — backwards
   * compatible with the manual `/ai-sdlc execute` path, which never runs
   * concurrent worktree ops.
   */
  mutexOpts?: WithWorktreeMutexOptions;
  /**
   * AISDLC-738 — re-enter the task's existing worktree and branch (a finished
   * task sent back for another round). Reuses the worktree when present,
   * otherwise re-adds it from the local branch or from `origin/<branch>`; it
   * never creates the branch from `origin/main` and throws when the branch
   * exists nowhere.
   */
  resume?: boolean;
  /** AISDLC-738 — the resume manifest was rebuilt and its branch name inferred; the error says so. */
  branchGuessed?: boolean;
  /**
   * AISDLC-738 — checks an existing worktree before a resume reuses it. Returns
   * null when it is a genuine registered worktree of this repository, else the
   * reason it is not. Defaults to `checkOwnWorktreeForOperator(workDir, worktree)`.
   */
  ownWorktreeCheck?: (worktreePath: string) => string | null;
  /** AISDLC-693 — filesystem reads for the hooks check; tests inject a fake. */
  hooksCheckFs?: HooksCheckFs;
  /** AISDLC-693 — active Node version for the engine-failure message (default `process.version`). */
  activeNodeVersion?: string;
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
): Promise<{
  safe: boolean;
  hadOpenPR: boolean;
  hadUncommittedChanges: boolean;
  hadDraftPR?: boolean;
}> {
  const taskIdLower = taskId.toLowerCase();

  // Predicate 1: open-PR check.
  // CRITICAL: fail CLOSED on any non-zero gh exit (token expired, network
  // timeout, gh not installed, rate limit). Without this, a transient gh
  // failure would let cleanup proceed against a branch with an open PR
  // and `git branch -D` would delete the local branch backing the live
  // PR. Mitigation: treat any gh-failure as "unknown PR state → unsafe".
  // (Code-reviewer + security-reviewer #377 both flagged this fail-open.)
  //
  // AISDLC-273 — differentiate DRAFT from READY PRs. A draft PR is the
  // intended mid-state in the AISDLC-218 workflow (dev pushes, opens
  // draft, reviewers run while draft, then `gh pr ready` flips it).
  // Auto-cleanup should STILL be refused (the branch has committed work),
  // but we surface a richer `hadDraftPR` signal so the caller can offer
  // the `--resume-from-draft` path instead of the generic "open PR found"
  // block. Ready PRs (reviewers already approved + CI running) are refused
  // with the same hard block as before.
  const prResult = await runner(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isDraft'],
    { cwd: workDir, allowFailure: true },
  );
  if (prResult.code !== 0) {
    // gh failed — fail closed, refuse cleanup.
    console.info(`[step-3] ${taskIdLower}: keeping branch (gh pr list failed; fail-closed)`);
    return { safe: false, hadOpenPR: false, hadUncommittedChanges: false };
  }
  let hadOpenPR: boolean;
  let hadDraftPR: boolean;
  try {
    const parsed = JSON.parse(prResult.stdout.trim() || '[]') as Array<{
      number: number;
      isDraft: boolean;
    }>;
    hadOpenPR = Array.isArray(parsed) && parsed.length > 0;
    // A PR is "draft-only" when EVERY open PR for this branch is a draft.
    // In practice there will only ever be one, but be defensive.
    hadDraftPR = hadOpenPR && parsed.every((pr) => pr.isDraft === true);
  } catch {
    // gh returned non-JSON — treat conservatively as having a ready open PR
    hadOpenPR = prResult.stdout.trim().length > 0;
    hadDraftPR = false;
  }
  if (hadOpenPR) {
    const kind = hadDraftPR ? 'draft PR' : 'ready PR';
    console.info(`[step-3] ${taskIdLower}: keeping branch (${kind} found for ${branch})`);
    return { safe: false, hadOpenPR: true, hadUncommittedChanges: false, hadDraftPR };
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

/**
 * AISDLC-738 — Step 3 for a resumed task: reuse the existing worktree, or
 * recreate it from the task's own branch (local, else `origin/<branch>`).
 */
async function resumeWorktree(
  runner: Runner,
  opts: SetupWorktreeOptions,
): Promise<SetupWorktreeResult> {
  // The SHA of origin/<branch> as of Step 3's fetch; Step 11 leases its push against it.
  const remoteSha = async (): Promise<{ remoteSha?: string }> => {
    const r = await runner(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${opts.branch}`],
      { cwd: opts.workDir, allowFailure: true },
    );
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? { remoteSha: sha } : {};
  };
  const headSha = async (): Promise<string> => {
    const r = await runner('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'], {
      allowFailure: true,
    });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  if (existsSync(join(opts.worktreePath, '.git'))) {
    const notOwn = (
      opts.ownWorktreeCheck ?? ((wt: string) => checkOwnWorktreeForOperator(opts.workDir, wt))
    )(opts.worktreePath);
    if (notOwn) {
      throw new Error(
        `Step 3 resume for ${opts.taskId}: ${opts.worktreePath} is not a registered worktree of this repository (${notOwn}); ` +
          `it is not reused. Remove or move it, or run \`/ai-sdlc cleanup ${opts.taskId}\`, then resume again`,
      );
    }
    const head = await runner(
      'git',
      ['-C', opts.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { allowFailure: true },
    );
    const current = head.stdout.trim();
    if (head.code !== 0 || current !== opts.branch) {
      throw new Error(
        `Step 3 resume for ${opts.taskId}: the worktree at ${opts.worktreePath} is on '${current || 'an unknown ref'}', not '${opts.branch}'`,
      );
    }
    return {
      branch: opts.branch,
      worktreePath: opts.worktreePath,
      baseSha: await headSha(),
      ...(await remoteSha()),
    };
  }
  const hasRef = async (ref: string): Promise<boolean> =>
    (
      await runner('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: opts.workDir,
        allowFailure: true,
      })
    ).code === 0;
  let addArgs: string[];
  if (await hasRef(`refs/heads/${opts.branch}`)) {
    addArgs = ['worktree', 'add', opts.worktreePath, opts.branch];
  } else if (await hasRef(`refs/remotes/origin/${opts.branch}`)) {
    addArgs = ['worktree', 'add', opts.worktreePath, '-b', opts.branch, `origin/${opts.branch}`];
  } else {
    throw new Error(
      `Step 3 resume for ${opts.taskId}: branch '${opts.branch}' exists neither locally nor on origin, ` +
        `so there is nothing to resume` +
        (opts.branchGuessed
          ? ` (the branch name was a guess: the task's manifest was rebuilt and its verdict recorded no pushed branch)`
          : '') +
        `. Run a normal \`/ai-sdlc execute ${opts.taskId}\` instead.`,
    );
  }
  const added = await runner('git', addArgs, { cwd: opts.workDir, allowFailure: true });
  if (added.code !== 0) {
    throw new Error(
      `git worktree add failed while resuming '${opts.branch}': ${added.stderr.trim() || 'unknown error'}`,
    );
  }
  return {
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    baseSha: await headSha(),
    ...(await remoteSha()),
  };
}

/**
 * AISDLC-738 — a resumed branch name flows into `git fetch` / `git worktree add`
 * as a positional argument, so a value shaped like an option (`--upload-pack=<cmd>`)
 * would be parsed by git as one. Allow only plain ref-name characters, and refuse
 * a leading '-', '..', '//', and a trailing '/', '.' or '.lock'.
 */
function assertSafeResumeBranch(taskId: string, branch: string): void {
  const safe =
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.startsWith('-') &&
    !branch.startsWith('/') &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !/[/.]$/.test(branch) &&
    !branch.endsWith('.lock');
  if (!safe) {
    throw new Error(
      `Step 3 resume for ${taskId}: refusing branch name '${branch}'; it is not a plain git ref name`,
    );
  }
}

export async function setupWorktree(opts: SetupWorktreeOptions): Promise<SetupWorktreeResult> {
  const runner = opts.runner ?? defaultRunner;

  if (opts.resume) {
    assertSafeResumeBranch(opts.taskId, opts.branch);
    if (!opts.skipFetch) {
      await runner('git', ['fetch', 'origin', opts.branch], {
        cwd: opts.workDir,
        timeout: 30_000,
        allowFailure: true,
      });
    }
    mkdirSync(join(opts.workDir, '.worktrees'), { recursive: true });
    const resumed = await withWorktreeMutex(() => resumeWorktree(runner, opts), opts.mutexOpts);
    const resumedHooks = await ensureWorktreeHooks({
      runner,
      workDir: opts.workDir,
      worktreePath: opts.worktreePath,
      fs: opts.hooksCheckFs,
      activeNodeVersion: opts.activeNodeVersion,
    });
    if (resumedHooks.status === 'missing') {
      throw new Error(`Step 3 refused to continue for ${opts.taskId}: ${resumedHooks.message}`);
    }
    return resumed;
  }

  if (!opts.skipFetch) {
    // git fetch does NOT touch .git/config — no mutex needed here.
    await runner('git', ['fetch', 'origin', 'main'], {
      cwd: opts.workDir,
      timeout: 30_000,
      allowFailure: true,
    });
  }

  // Idempotent mkdir of `.worktrees/`
  mkdirSync(join(opts.workDir, '.worktrees'), { recursive: true });

  // AISDLC-241 — wrap git worktree add (and any sibling cleanup ops) in the
  // mutex so concurrent ticks cannot race on .git/config.lock.
  const created = await withWorktreeMutex(async () => {
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
          const baseShaResult = await runner(
            'git',
            ['-C', opts.worktreePath, 'rev-parse', 'HEAD'],
            { allowFailure: true },
          );
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
  }, opts.mutexOpts);

  // AISDLC-693 — fail closed: a worktree with no hooks directory runs no gate at
  // all, so nothing may proceed to a commit from it. Runs outside the mutex (it
  // may install dependencies, which takes minutes and touches no shared git config).
  const hooks = await ensureWorktreeHooks({
    runner,
    workDir: opts.workDir,
    worktreePath: opts.worktreePath,
    fs: opts.hooksCheckFs,
    activeNodeVersion: opts.activeNodeVersion,
  });
  if (hooks.status === 'missing') {
    throw new Error(`Step 3 refused to continue for ${opts.taskId}: ${hooks.message}`);
  }
  if (opts.taskFilePathOverride && existsSync(opts.taskFilePathOverride)) {
    const destDir = join(opts.worktreePath, 'backlog', 'tasks');
    const dest = join(destDir, basename(opts.taskFilePathOverride));
    if (resolve(opts.taskFilePathOverride) !== resolve(dest)) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(opts.taskFilePathOverride, dest);
    }
  }
  return created;
}

/**
 * AISDLC-273 — detect whether an open PR for the given branch is a DRAFT PR
 * (vs a ready-for-review PR). This is the basis for the `--resume-from-draft`
 * recovery path: a draft PR is the intended AISDLC-218 mid-state, while a
 * ready PR means reviewers have already been notified and CI may be running.
 *
 * Returns null when gh fails or no open PR exists. Returns a shape describing
 * the PR state when one is found.
 */
export async function detectDraftPrForBranch(
  runner: Runner,
  workDir: string,
  branch: string,
): Promise<{ prNumber: number; isDraft: boolean; prUrl: string } | null> {
  const result = await runner(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isDraft,url'],
    { cwd: workDir, allowFailure: true },
  );
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim() || '[]') as Array<{
      number: number;
      isDraft: boolean;
      url: string;
    }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const pr = parsed[0];
    return { prNumber: pr.number, isDraft: pr.isDraft === true, prUrl: pr.url ?? '' };
  } catch {
    return null;
  }
}
