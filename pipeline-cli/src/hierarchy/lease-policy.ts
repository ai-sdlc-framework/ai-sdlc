/**
 * Checks the playbook applies before it pushes a task branch, ported from the
 * plugin's `hooks/lib/lease-push-guard.js` (`isProtectedBranch`) and
 * `hooks/lib/trusted-policy.js` (`resolveLeaseWorktree`).
 *
 * `lease-policy.test.ts` runs both versions against the same fixtures so the two
 * cannot drift apart. Unlike the hook, the worktree check here reads the
 * filesystem only: it never runs git inside a worktree it has not yet verified.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { runGit, verifiedMainRoot, type GitRunner } from './trusted-root.js';

/** `allowForcePush` as the trusted policy resolves it. */
export type ForcePushMode = 'never' | 'leaseOnOwnBranch';

/** Always protected, merged with the policy's `protectedBranches` (`*` matches any run). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = [
  'main',
  'master',
  'release-please--branches--*',
  'gh-pages',
  'production',
  'prod',
  'release/*',
  'releases/*',
];

/** Simple `*` glob, case-insensitive; an odd pattern fails closed (matches everything). */
function globMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  if (!/^[a-z0-9._/*-]+$/.test(p)) return true;
  const re = new RegExp(
    `^${p
      .split('*')
      .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name.toLowerCase());
}

/** True when `name` (a branch, with or without `refs/heads/`) is protected by default or by `extra`. */
export function isProtectedBranch(name: string, extra: readonly string[]): boolean {
  const short = name.replace(/^refs\/heads\//, '');
  for (const p of [...DEFAULT_PROTECTED_BRANCHES, ...extra]) {
    if (globMatch(p, short)) return true;
  }
  return false;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isUnder(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Null when `worktree` is a genuine task worktree of the repository at `repoRoot`,
 * otherwise the reason it is not. All of these must hold:
 *  - `repoRoot` is the verified main checkout (a real `.git` directory);
 *  - the worktree's real path is a direct child of `<main>/.worktrees/`;
 *  - its `.git` is a plain file (not a symlink) whose `gitdir:` line leads to a
 *    direct child of `<main>/.git/worktrees/`;
 *  - that git dir's `gitdir` back-pointer leads to `<worktree>/.git`, and its
 *    `commondir`, when present, leads to `<main>/.git`.
 */
export function checkOwnWorktree(
  repoRoot: string,
  worktree: string,
  run: GitRunner = runGit,
): string | null {
  try {
    const mainRoot = verifiedMainRoot(repoRoot, run);
    if (!mainRoot) return 'the main checkout cannot be verified';
    const realMain = safeReal(mainRoot);
    if (safeReal(repoRoot) !== realMain) return 'the repository root is not the main checkout';
    const worktreesDir = path.join(realMain, '.worktrees');
    const top = safeReal(worktree);
    if (path.dirname(top) !== worktreesDir) return 'it is not a direct child of .worktrees/';
    const dotGit = path.join(top, '.git');
    const st = lstatSync(dotGit);
    if (!st.isFile() || st.isSymbolicLink()) return 'its .git is not a plain file';
    const first = readFileSync(dotGit, 'utf-8').split('\n')[0] ?? '';
    // String operations, not a regex: this line comes from a worktree-controlled file.
    const target = first.startsWith('gitdir:') ? first.slice('gitdir:'.length).trim() : '';
    if (!target) return 'its .git file has no gitdir line';
    const gitDir = safeReal(path.resolve(top, target));
    const registry = path.join(realMain, '.git', 'worktrees');
    if (!isUnder(gitDir, registry) || path.dirname(gitDir) !== registry) {
      return 'its git dir is not registered under the main checkout';
    }
    const back = readFileSync(path.join(gitDir, 'gitdir'), 'utf-8').trim();
    if (safeReal(back) !== path.join(top, '.git')) return 'its git dir does not point back at it';
    let common: string | null = null;
    try {
      common = readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    } catch {
      common = null;
    }
    if (common !== null && safeReal(path.resolve(gitDir, common)) !== path.join(realMain, '.git')) {
      return 'its common dir is not the main checkout';
    }
    return null;
  } catch {
    return 'it could not be verified';
  }
}
