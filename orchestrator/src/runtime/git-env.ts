/**
 * Helpers for safely invoking `git` subprocesses inside isolated working
 * directories.
 *
 * ## Why this exists (AISDLC-68 → AISDLC-72)
 *
 * When a husky pre-push hook (or any nested git invocation) runs commands
 * from inside `.worktrees/<id>/`, git exports `GIT_DIR`, `GIT_WORK_TREE`,
 * and `GIT_INDEX_FILE` into the child process environment so subprocesses
 * "stay" in the calling worktree's git context. That's the right behavior
 * for normal subprocesses — but it's catastrophic for code that creates
 * its own throwaway repository in a temp directory.
 *
 * Without sanitizing the environment:
 *   - `execSync('git init', { cwd: tmpDir })` initializes the *parent*
 *     worktree's index, not tmpDir's.
 *   - `execSync('git commit', { cwd: tmpDir })` writes a commit onto the
 *     *parent's* current branch using files from tmpDir — silently
 *     corrupting the feature branch with leaked test artifacts.
 *   - The pre-push hook that triggered this whole cascade then sees
 *     unexpected commits and either fails or worse, ships them.
 *
 * The fix is uniform: strip `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
 * from the inherited env at every site that runs `git` against an explicit
 * `cwd`. PR #78 patched the tokens-studio adapter; AISDLC-72 sweeps the
 * orchestrator + remaining test sites.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Return a copy of `process.env` with the git-context env vars removed.
 *
 * Use this for any subprocess that runs `git` against an explicit `cwd`
 * different from the calling process's CWD (temp repos, sibling repos,
 * worktree-pool clones).
 */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/**
 * Promisified `execFile('git', args, opts)` wrapper that strips the git
 * context env vars before invocation. Use whenever the caller passes
 * `cwd` (i.e. running git in a directory other than the parent process's
 * CWD).
 *
 * Caller-supplied `opts.env` takes precedence — it's already explicit
 * about what to inherit. We only inject `cleanGitEnv()` when no env was
 * provided.
 */
export async function gitExecFile(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = opts.env ?? cleanGitEnv();
  const { stdout, stderr } = await execFileAsync('git', args, { ...opts, env });
  return { stdout, stderr };
}
