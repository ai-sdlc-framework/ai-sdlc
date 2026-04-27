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

export interface CrossRepoWrite {
  /** Sibling repository absolute path. */
  repoPath: string;
  /** Files modified or added in that sibling, relative to its root. */
  files: string[];
}

/**
 * Detect writes the agent made into sibling git repositories (i.e., directories
 * adjacent to `workDir` that are themselves git repos). Surfaced as a warning,
 * not a hard failure — the AISDLC-68 task LEGITIMATELY needed to sync into
 * `../ai-sdlc-io/`, and we don't want to forbid that. The orchestrator just
 * needs to surface that the changes exist so the operator knows to commit them
 * separately in the sibling repo.
 *
 * Returns one entry per dirty sibling repo, with the list of changed files.
 * Empty array when no siblings are dirty (the common case).
 */
export async function detectCrossRepoWrites(workDir: string): Promise<CrossRepoWrite[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { dirname, join, resolve } = await import('node:path');

  let workTreeRoot: string;
  try {
    workTreeRoot = await gitExec(workDir, ['rev-parse', '--show-toplevel']);
  } catch {
    return [];
  }

  const parent = dirname(resolve(workTreeRoot));
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }

  const writes: CrossRepoWrite[] = [];
  for (const entry of entries) {
    const candidate = join(parent, entry);
    if (resolve(candidate) === resolve(workTreeRoot)) continue; // skip self
    try {
      const s = await stat(candidate);
      if (!s.isDirectory()) continue;
      // Quick git-repo check via `rev-parse --is-inside-work-tree`.
      await gitExec(candidate, ['rev-parse', '--is-inside-work-tree']);
    } catch {
      continue;
    }
    try {
      const status = await gitExec(candidate, ['status', '--porcelain']);
      if (!status.trim()) continue;
      // Porcelain v1: first 2 chars are status (XY), then 1+ whitespace, then
      // path. Cannot use slice(3) — gitExec already trimmed the leading space
      // when X is unmodified ("M " becomes "M" after trim, dropping a column
      // and eating the first filename character).
      const files = status
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^.{1,2}\s+(.+)$/);
          return m ? m[1] : line;
        });
      writes.push({ repoPath: candidate, files });
    } catch {
      // Couldn't read status — skip silently.
    }
  }
  return writes;
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
