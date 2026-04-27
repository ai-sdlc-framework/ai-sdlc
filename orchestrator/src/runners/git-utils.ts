/**
 * Shared git utilities for agent runners.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Run a git command in the given directory. */
export async function gitExec(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: workDir });
  return stdout.trim();
}

export interface DetectedChanges {
  filesChanged: string[];
  agentAlreadyCommitted: boolean;
}

export interface WorktreeBaseline {
  /** Set of paths that were untracked BEFORE the agent ran. */
  untracked: Set<string>;
  /** Set of paths that had unstaged modifications BEFORE the agent ran. */
  modified: Set<string>;
}

/**
 * Snapshot the untracked + modified file lists in the worktree. Captured before
 * the agent runs so detectChangedFiles can subtract pre-existing noise (SQLite
 * working files, draft RFCs the user hasn't decided to commit yet, in-flight
 * edits on the previous branch). Without this, `git add -A` sweeps everything
 * into the agent's commit (the AISDLC-68 incident).
 *
 * Failures degrade gracefully to an empty baseline — never block the pipeline
 * because the snapshot couldn't run.
 */
export async function snapshotWorktree(workDir: string): Promise<WorktreeBaseline> {
  try {
    const [untrackedOutput, modifiedOutput] = await Promise.all([
      gitExec(workDir, ['ls-files', '--others', '--exclude-standard']),
      gitExec(workDir, ['diff', '--name-only']),
    ]);
    return {
      untracked: new Set(untrackedOutput.split('\n').filter(Boolean)),
      modified: new Set(modifiedOutput.split('\n').filter(Boolean)),
    };
  } catch {
    return { untracked: new Set(), modified: new Set() };
  }
}

/**
 * Detect files changed by an agent — checks both uncommitted changes and
 * already-committed changes (agent may have self-committed). When `baseline`
 * is provided, untracked files that existed BEFORE the agent ran are excluded
 * (they belong to the user, not the agent's diff).
 */
export async function detectChangedFiles(
  workDir: string,
  baseline?: WorktreeBaseline,
): Promise<DetectedChanges> {
  const diffOutput = await gitExec(workDir, ['diff', '--name-only']);
  const untrackedOutput = await gitExec(workDir, ['ls-files', '--others', '--exclude-standard']);

  const allUntracked = untrackedOutput.split('\n').filter(Boolean);
  // Untracked files that existed pre-agent are user state — exclude them.
  const agentUntracked = baseline
    ? allUntracked.filter((f) => !baseline.untracked.has(f))
    : allUntracked;

  const uncommittedFiles = [...diffOutput.split('\n').filter(Boolean), ...agentUntracked];

  // Check if agent already committed — compare against merge base with main
  let committedFiles: string[] = [];
  let agentAlreadyCommitted = false;
  try {
    const mergeBase = (await gitExec(workDir, ['merge-base', 'HEAD', 'origin/main'])).trim();
    if (mergeBase) {
      const commitDiff = await gitExec(workDir, ['diff', '--name-only', `${mergeBase}..HEAD`]);
      committedFiles = commitDiff.split('\n').filter(Boolean);
      agentAlreadyCommitted = committedFiles.length > 0 && uncommittedFiles.length === 0;
    }
  } catch {
    // merge-base may fail if main doesn't exist locally — that's fine
  }

  return {
    filesChanged: agentAlreadyCommitted ? committedFiles : uncommittedFiles,
    agentAlreadyCommitted,
  };
}

/**
 * Run lint and format auto-fix commands (best-effort, non-fatal).
 */
export async function runAutoFix(
  workDir: string,
  lintCmd?: string,
  fmtCmd?: string,
): Promise<void> {
  if (fmtCmd) {
    try {
      const [bin, ...args] = fmtCmd.split(' ');
      await execFileAsync(bin, args, { cwd: workDir });
    } catch {
      // Format failures are non-fatal
    }
  }
  if (lintCmd) {
    try {
      const [bin, ...args] = lintCmd.split(' ');
      await execFileAsync(bin, args, { cwd: workDir });
    } catch {
      // Lint --fix failures are non-fatal
    }
  }
}
