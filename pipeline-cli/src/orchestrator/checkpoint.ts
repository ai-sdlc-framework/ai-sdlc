/**
 * Periodic checkpoint-commit helper (AISDLC-242, Mechanism 1).
 *
 * When a dev subagent runs inside an orchestrator-managed worktree it can
 * call `emitCheckpointCommit()` to preserve partial work as a
 * `wip(checkpoint):` commit. On the next `cli-orchestrator tick` — whether
 * that happens because the previous session was killed cleanly or because
 * the operator manually re-ran tick — the orchestrator detects these commits
 * and logs them so both the operator and a resuming dev subagent know how
 * far the previous session progressed.
 *
 * ## Why `--no-verify` on checkpoint commits
 *
 * Checkpoint commits are INTERNAL to the dev subagent's working session.
 * They are NOT pushed to `origin` directly; they are squash-rebased (via
 * `git rebase --autosquash`) before the final push in the normal pipeline
 * flow. Running hooks on every checkpoint commit would:
 *   1. Slow down the subagent loop (coverage + drift gates take seconds).
 *   2. Fail on partial/incomplete diffs (tests may not pass mid-edit).
 *   3. Interfere with the attestation-sign hook (envelope not yet ready).
 *
 * The `--no-verify` flag here is deliberately scoped to the ephemeral
 * internal checkpoint commits — NOT the final push. The final push in
 * Step 11 always runs with full hook enforcement.
 *
 * ## Autosquash convention
 *
 * The `wip(checkpoint):` prefix is git's `fixup!` / `squash!` convention
 * generalised. Before the final push, the pipeline runs:
 *
 *   git rebase --autosquash --interactive origin/main
 *
 * with GIT_SEQUENCE_EDITOR='sed -i s/^pick/fixup/' so checkpoint commits
 * collapse into the work commit beneath them automatically without operator
 * interaction.
 *
 * @module orchestrator/checkpoint
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Return `process.env` with `GIT_DIR` and `GIT_WORK_TREE` stripped.
 *
 * AISDLC-260: when these vars are present (e.g. inside a husky pre-push
 * hook, where `git push` exports `GIT_DIR=<host-repo>/.git` to its child
 * processes), git ignores the `cwd` we pass to `execSync` and operates on
 * the bleed target instead. That made checkpoint commits emitted from
 * inside a test fixture land on the host worktree's branch — see
 * AISDLC-260 for the post-mortem of the polluted `aisdlc-259` branch.
 *
 * Production callers still inherit identity (`user.email`, `user.name`)
 * from per-repo `.git/config`, which git reads regardless of `GIT_DIR`.
 */
function productionGitEnv(): NodeJS.ProcessEnv {
  // Spread is intentional: we want every other env var (PATH, HOME, etc.)
  // to inherit. We only strip the two repo-discovery overrides.
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  return env;
}

export interface CheckpointOptions {
  /**
   * Absolute path to the worktree root where the checkpoint commit should
   * be created. The worktree must exist on disk.
   */
  worktreePath: string;
  /**
   * Human-readable annotation stamped in the commit message. Keep short
   * (one line). Example: `"after editing 3 files in pipeline-cli/src"`.
   */
  annotation: string;
  /**
   * Task ID — embedded in the commit message so `git log` shows context.
   * Example: `"AISDLC-242"`.
   */
  taskId: string;
  /**
   * Optional override for the commit timestamp in seconds since epoch.
   * Used by tests for deterministic output. Production leaves undefined.
   */
  nowSec?: number;
}

export interface CheckpointResult {
  /** Whether the checkpoint commit was successfully created. */
  committed: boolean;
  /**
   * The short SHA of the new checkpoint commit. Set only when
   * `committed` is true; undefined when there was nothing to commit or
   * the git command failed.
   */
  sha?: string;
  /**
   * Human-readable reason when `committed` is false. Typical values:
   *   - `"nothing-to-commit"` — working tree was clean.
   *   - `"worktree-missing"` — the worktree path does not exist on disk.
   *   - `"git-error: <msg>"` — a git command failed.
   */
  reason?: string;
}

/**
 * Emit a `wip(checkpoint):` commit in the given worktree, capturing all
 * current staged + unstaged changes (equivalent to `git add -A`).
 *
 * Returns `{ committed: false, reason: 'nothing-to-commit' }` when the
 * working tree is already clean — the caller can safely call this on a
 * regular cadence without producing empty commits.
 *
 * The commit uses `--no-verify` so pre-commit hooks are skipped (coverage,
 * drift, lint) — these run only on the final push after the checkpoints are
 * squashed away. The commit also uses `-c commit.gpgsign=false` so GPG
 * signing is bypassed in environments where the signing key is absent (Tier 2
 * orchestrator contexts often run without a signing key loaded).
 */
export function emitCheckpointCommit(opts: CheckpointOptions): CheckpointResult {
  if (!existsSync(opts.worktreePath)) {
    return { committed: false, reason: 'worktree-missing' };
  }

  const cwd = opts.worktreePath;

  // Check whether there is anything to commit. `git status --porcelain`
  // produces one line per changed file; empty output means clean tree.
  let statusOutput: string;
  try {
    statusOutput = execSync('git status --porcelain', {
      cwd,
      env: productionGitEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { committed: false, reason: `git-error: ${msg}` };
  }

  if (!statusOutput.trim()) {
    return { committed: false, reason: 'nothing-to-commit' };
  }

  // Stage everything (modified + untracked). Intentional: checkpoint commits
  // capture the full snapshot including files the dev hasn't explicitly staged.
  try {
    execSync('git add -A', {
      cwd,
      env: productionGitEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { committed: false, reason: `git-error: ${msg}` };
  }

  // Build the commit message. The `wip(checkpoint):` prefix makes the commit
  // identifiable in `git log` + `git shortlog`, and it's what the
  // squash-rebase query uses to locate checkpoints:
  //
  //   git log --oneline --grep='^wip(checkpoint):' origin/main..HEAD
  const subject = `wip(checkpoint): ${opts.annotation} (${opts.taskId})`;

  // Commit with --no-verify (skip hooks) and -c commit.gpgsign=false
  // (no GPG in unattended Tier 2). GIT_AUTHOR_NAME / GIT_COMMITTER_NAME
  // inherit from the environment (same as every other orchestrator git call).
  //
  // SECURITY (AISDLC-242 fix): use execFileSync (argv array) instead of
  // execSync (shell string) so that shell metacharacters in `subject` —
  // e.g. an annotation derived from an agent-controlled task title like
  // "$(touch /tmp/pwned)" — cannot trigger command substitution or word
  // splitting. git -c key=value is passed as discrete argv elements; the
  // commit message is a single element. No shell involvement.
  let rawSha: string;
  try {
    rawSha = execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', subject],
      {
        cwd,
        env: productionGitEnv(),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { committed: false, reason: `git-error: ${msg}` };
  }

  // Extract the short SHA from git's output. git commit prints something like:
  //   [ai-sdlc/aisdlc-242-... abc1234] wip(checkpoint): ...
  const shaMatch = rawSha.match(/\[.*?\s+([0-9a-f]{5,40})\]/);
  const sha = shaMatch?.[1];

  return { committed: true, sha };
}

/**
 * Count the `wip(checkpoint):` commits on the current branch beyond
 * `origin/main`. Returns 0 when the worktree is missing or git fails
 * (best-effort by design — the caller only uses this for informational
 * logging, not correctness decisions).
 */
export function countCheckpointCommits(worktreePath: string): number {
  if (!existsSync(worktreePath)) return 0;
  try {
    const output = execSync(`git log --oneline --grep="^wip(checkpoint):" origin/main..HEAD`, {
      cwd: worktreePath,
      env: productionGitEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim() ? output.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

/**
 * Count ALL commits on the current branch beyond `origin/main` (including
 * non-checkpoint commits). Returns 0 on any error.
 */
export function countCommitsBeyondMain(worktreePath: string): number {
  if (!existsSync(worktreePath)) return 0;
  try {
    const output = execSync('git rev-list --count origin/main..HEAD', {
      cwd: worktreePath,
      env: productionGitEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const n = parseInt(output.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the path to a worktree for a given task ID inside the
 * project's `.worktrees/` directory. Does not check whether the path
 * exists — that is the caller's responsibility.
 */
export function worktreePath(workDir: string, taskId: string): string {
  return join(workDir, '.worktrees', taskId.toLowerCase());
}

/**
 * Detect whether a recoverable-abort sentinel exists for the given task ID.
 *
 * A recoverable worktree is one that:
 *   1. Exists on disk at `.worktrees/<task-id-lower>/`.
 *   2. Has an `.active-task` sentinel file whose content matches the task ID
 *      (meaning Step 4 ran and the worktree was never cleaned up).
 *   3. Has at least one commit beyond `origin/main` on its branch.
 *
 * These three predicates together mean "the previous dispatch was killed
 * mid-flight with partial work preserved" — the recoverable-abort scenario.
 *
 * Returns the worktree path when a recoverable state is detected, or
 * `null` when the worktree is absent / clean / stale.
 */
export function detectRecoverableWorktree(
  workDir: string,
  taskId: string,
): { worktreePath: string; commitCount: number; checkpointCount: number } | null {
  const wPath = worktreePath(workDir, taskId);
  if (!existsSync(wPath)) return null;

  // Check sentinel
  const sentinelPath = join(wPath, '.active-task');
  if (!existsSync(sentinelPath)) return null;

  let sentinelContent: string;
  try {
    sentinelContent = readFileSync(sentinelPath, 'utf8').trim();
  } catch {
    return null;
  }

  // Sentinel must claim this task
  if (sentinelContent.toLowerCase() !== taskId.toLowerCase()) return null;

  const commitCount = countCommitsBeyondMain(wPath);
  if (commitCount === 0) return null;

  const checkpointCount = countCheckpointCommits(wPath);
  return { worktreePath: wPath, commitCount, checkpointCount };
}
