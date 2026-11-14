/**
 * AISDLC-1275 - post-hoc protected-path check for untrusted runs.
 *
 * The PreToolUse hook matches Bash command text and cannot be made complete (variable, glob
 * and script-file forms evade it). The control that holds is the result: before an untrusted
 * run pushes, every path changed between the base and the working tree is checked against the
 * protected list. Mirrors `UNTRUSTED_PROTECTED` in ai-sdlc-plugin/hooks/enforce-blocked-actions.js
 * (a test fails when the two differ).
 */

import type { Runner } from '../runtime/exec.js';

export const UNTRUSTED_PROTECTED_PATHS: readonly (readonly string[])[] = [
  ['.ai-sdlc'],
  ['.github', 'workflows'],
  ['.claude'],
  ['.husky'],
  ['ai-sdlc-plugin', 'hooks'],
  // The `.git/*` entries never match git-reported paths (git does not list .git); kept for
  // parity with the hook's UNTRUSTED_PROTECTED list, which the parity test compares.
  ['.git', 'hooks'],
  ['.git', 'config'],
  ['.git', 'worktrees'],
  // AISDLC-1276: files that run code or instruct an agent (lowercase: matching is case-insensitive).
  ['package.json'],
  ['pnpm-lock.yaml'],
  ['pnpm-workspace.yaml'],
  ['.npmrc'],
  ['scripts'],
  ['claude.md'],
  ['.mcp.json'],
];

export const UNTRUSTED_PROTECTED_CAUSE = 'untrusted-protected-path';

/** True when a repo-relative path contains a protected segment sequence. */
export function isUntrustedProtectedPath(p: string): boolean {
  // Case-insensitive: macOS/Windows checkouts are case-insensitive, so `.AI-SDLC/` is the same dir.
  const segs = p
    .toLowerCase()
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  return UNTRUSTED_PROTECTED_PATHS.some((seq) =>
    segs.some((_, i) => seq.every((part, j) => segs[i + j] === part)),
  );
}

/** Make git ignore refs/replace/*, as `git push` does. */
export const NO_REPLACE_ENV: NodeJS.ProcessEnv = { GIT_NO_REPLACE_OBJECTS: '1' };

/**
 * List every protected path changed since `baseRef`: committed, staged, unstaged and untracked.
 * `baseRef` must be a SHA recorded before the agent ran.
 * Renames are split into delete + add so both ends are checked; mode changes and deletions
 * appear in `git diff --name-only`.
 */
export async function findProtectedPathChanges(opts: {
  worktreePath: string;
  baseRef: string;
  /** Exact commit that will be pushed; defaults to symbolic HEAD. */
  headRef?: string;
  runner: Runner;
}): Promise<string[]> {
  const head = opts.headRef ?? 'HEAD';
  // GIT_NO_REPLACE_OBJECTS=1: `git push` ignores refs/replace/*, so the check must too, or a replace
  // ref could show a harmless commit while the push sends the real protected change.
  const run = async (args: string[]): Promise<string[]> => {
    const r = await opts.runner('git', args, {
      cwd: opts.worktreePath,
      allowFailure: true,
      env: NO_REPLACE_ENV,
    });
    if (r.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || 'unknown error'}`);
    }
    return r.stdout.split('\0').filter((s) => s !== '');
  };
  // Every path touched by any commit in base..HEAD (the push sends commits, not the working tree,
  // so a protected change committed then restored on disk must still be caught), plus the dirty tree.
  const committed = await run([
    'log',
    '--name-only',
    '--no-renames',
    '--format=',
    '-z',
    `${opts.baseRef}..${head}`,
  ]);
  // Tree-to-tree: catches a merge commit (git log prints no paths for one) and any commit-tree
  // built history, independent of the working tree.
  const treeDiff = await run(['diff', '--name-only', '--no-renames', '-z', opts.baseRef, head]);
  const changed = await run(['diff', '--name-only', '--no-renames', '-z', opts.baseRef]);
  const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...committed, ...treeDiff, ...changed, ...untracked])]
    .filter(isUntrustedProtectedPath)
    .sort();
}
