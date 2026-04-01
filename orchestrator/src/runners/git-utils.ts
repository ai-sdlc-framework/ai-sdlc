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

/**
 * Detect files changed by an agent — checks both uncommitted changes
 * and already-committed changes (agent may have self-committed).
 */
export async function detectChangedFiles(workDir: string): Promise<DetectedChanges> {
  const diffOutput = await gitExec(workDir, ['diff', '--name-only']);
  const untrackedOutput = await gitExec(workDir, ['ls-files', '--others', '--exclude-standard']);

  const uncommittedFiles = [
    ...diffOutput.split('\n').filter(Boolean),
    ...untrackedOutput.split('\n').filter(Boolean),
  ];

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
