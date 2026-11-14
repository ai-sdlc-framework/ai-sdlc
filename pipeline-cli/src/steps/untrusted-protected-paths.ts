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
  ['.git', 'hooks'],
  ['.git', 'config'],
  ['.git', 'worktrees'],
];

export const UNTRUSTED_PROTECTED_CAUSE = 'untrusted-protected-path';

/** True when a repo-relative path contains a protected segment sequence. */
export function isUntrustedProtectedPath(p: string): boolean {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  return UNTRUSTED_PROTECTED_PATHS.some((seq) =>
    segs.some((_, i) => seq.every((part, j) => segs[i + j] === part)),
  );
}

/**
 * List every protected path changed since `baseRef`: committed, staged, unstaged and untracked.
 * Renames are split into delete + add so both ends are checked; mode changes and deletions
 * appear in `git diff --name-only`.
 */
export async function findProtectedPathChanges(opts: {
  worktreePath: string;
  baseRef: string;
  runner: Runner;
}): Promise<string[]> {
  const run = async (args: string[]): Promise<string[]> => {
    const r = await opts.runner('git', args, { cwd: opts.worktreePath, allowFailure: true });
    if (r.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || 'unknown error'}`);
    }
    return r.stdout.split('\0').filter((s) => s !== '');
  };
  const changed = await run(['diff', '--name-only', '--no-renames', '-z', opts.baseRef]);
  const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...changed, ...untracked])].filter(isUntrustedProtectedPath).sort();
}
