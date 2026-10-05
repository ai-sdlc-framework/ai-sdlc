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

/** Task id (lower-case) from the worktree's `.active-task`; null when absent or malformed. */
function readTaskId(worktreeRoot: string): string | null {
  try {
    const first = (
      readFileSync(path.join(worktreeRoot, '.active-task'), 'utf-8').split('\n')[0] ?? ''
    ).trim();
    return /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z][A-Za-z0-9]*)*-\d+(\.\d+)*$/.test(first)
      ? first.toLowerCase()
      : null;
  } catch {
    return null;
  }
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
function checkWorktreeStructure(
  repoRoot: string,
  worktree: string,
  run: GitRunner,
): { reason: string } | { top: string } {
  try {
    const mainRoot = verifiedMainRoot(repoRoot, run);
    if (!mainRoot) return { reason: 'the main checkout cannot be verified' };
    const realMain = safeReal(mainRoot);
    if (safeReal(repoRoot) !== realMain)
      return { reason: 'the repository root is not the main checkout' };
    const worktreesDir = path.join(realMain, '.worktrees');
    const top = safeReal(worktree);
    if (path.dirname(top) !== worktreesDir)
      return { reason: 'it is not a direct child of .worktrees/' };
    const dotGit = path.join(top, '.git');
    const st = lstatSync(dotGit);
    if (!st.isFile() || st.isSymbolicLink()) return { reason: 'its .git is not a plain file' };
    const first = readFileSync(dotGit, 'utf-8').split('\n')[0] ?? '';
    // String operations, not a regex: this line comes from a worktree-controlled file.
    const target = first.startsWith('gitdir:') ? first.slice('gitdir:'.length).trim() : '';
    if (!target) return { reason: 'its .git file has no gitdir line' };
    const gitDir = safeReal(path.resolve(top, target));
    const registry = path.join(realMain, '.git', 'worktrees');
    if (!isUnder(gitDir, registry) || path.dirname(gitDir) !== registry) {
      return { reason: 'its git dir is not registered under the main checkout' };
    }
    const back = readFileSync(path.join(gitDir, 'gitdir'), 'utf-8').trim();
    if (safeReal(back) !== path.join(top, '.git'))
      return { reason: 'its git dir does not point back at it' };
    let common: string | null = null;
    try {
      common = readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    } catch {
      common = null;
    }
    if (common !== null && safeReal(path.resolve(gitDir, common)) !== path.join(realMain, '.git')) {
      return { reason: 'its common dir is not the main checkout' };
    }
    return { top };
  } catch {
    return { reason: 'it could not be verified' };
  }
}

/*
 * Two variants share the structural checks above and differ ONLY in the session-task
 * binding. Strict is what the PreToolUse hook enforces for an AGENT session, which is
 * bound to one task via AI_SDLC_ACTIVE_TASK_ID; it is lockstep-tested against the hook.
 * Operator is the dispatch session's `cli-hierarchy tick` acting on behalf of an
 * executor worktree, where there is no session task; it never reaches an agent's push
 * path and behaves exactly as checkOwnWorktree did before AISDLC-710.
 */
export function checkOwnWorktreeStrict(
  repoRoot: string,
  worktree: string,
  run: GitRunner = runGit,
): string | null {
  const r = checkWorktreeStructure(repoRoot, worktree, run);
  if ('reason' in r) return r.reason;
  // Checked last so every structural refusal keeps its specific reason.
  const bound = (process.env['AI_SDLC_ACTIVE_TASK_ID'] || '').toLowerCase();
  if (!bound || readTaskId(r.top) !== bound) {
    return 'the session is not bound to this task (AI_SDLC_ACTIVE_TASK_ID / .active-task)';
  }
  return null;
}

export function checkOwnWorktreeForOperator(
  repoRoot: string,
  worktree: string,
  run: GitRunner = runGit,
): string | null {
  const r = checkWorktreeStructure(repoRoot, worktree, run);
  return 'reason' in r ? r.reason : null;
}

/** Alias of the strict (hook-lockstep) variant. */
export const checkOwnWorktree = checkOwnWorktreeStrict;
