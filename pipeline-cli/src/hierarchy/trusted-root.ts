/**
 * Main-checkout resolution for reading policy, ported from the plugin's
 * `hooks/lib/trusted-policy.js` (`mainCheckoutRoot` / `verifiedMainRoot`).
 *
 * The `.git` chain of a worktree (`.git` file, gitdir, commondir) is writable by
 * an agent, so a policy file is only trusted when it comes from a checkout whose
 * `.git` is a real directory (not a file, not a symlink) and whose realpath equals
 * the git common dir. Any doubt returns null and the caller grants nothing.
 * `trusted-root.test.ts` runs this and the hook's version against the same fixture
 * repositories so the two cannot drift apart.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { stripGitRedirects } from './git-env.js';

const GIT_TIMEOUT_MS = 2000;

/** Runs git and returns trimmed stdout, or null on any failure, timeout or empty output. */
export type GitRunner = (args: readonly string[], cwd: string) => string | null;

/** Production runner: argv only, no shell, short timeout, every git-redirecting variable removed. */
export const runGit: GitRunner = (args, cwd) => {
  const env = stripGitRedirects(process.env);
  try {
    return (
      execFileSync('git', [...args], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        env,
      }).trim() || null
    );
  } catch {
    return null;
  }
};

export function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Real path of `p` even when it does not exist yet: the nearest existing ancestor
 * is resolved with `realpath` and the missing segments are appended unchanged. Used
 * to compare a path the caller supplied with a trusted one, so a board directory
 * that is not created yet, or a checkout reached through a symlink, compares equal.
 */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...[...missing].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Main checkout root from the git common dir; only a common dir literally named `.git` is accepted. */
export function mainCheckoutRoot(dir: string, run: GitRunner = runGit): string | null {
  const common = run(['rev-parse', '--git-common-dir'], dir);
  if (!common) return null;
  const abs = path.resolve(dir, common);
  if (path.basename(abs) !== '.git') return null;
  return path.dirname(abs);
}

/**
 * Like {@link mainCheckoutRoot}, but cross-checked against the filesystem:
 * `<root>/.git` must be a real directory (not a symlink) whose realpath equals the
 * reported common dir.
 */
export function verifiedMainRoot(dir: string, run: GitRunner = runGit): string | null {
  const root = mainCheckoutRoot(dir, run);
  if (!root) return null;
  try {
    const dotGit = path.join(root, '.git');
    const st = lstatSync(dotGit);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const common = run(['rev-parse', '--git-common-dir'], dir);
    if (!common || safeReal(dotGit) !== safeReal(path.resolve(dir, common))) return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * Root of the main checkout both `projectDir` and `cwd` belong to, or null. The two
 * must verify and resolve to the same checkout.
 */
export function trustedPolicyRoot(
  projectDir: string,
  cwd: string,
  run: GitRunner = runGit,
): string | null {
  const projectRoot = verifiedMainRoot(projectDir, run);
  if (!projectRoot) return null;
  const cwdRoot = verifiedMainRoot(cwd, run);
  if (!cwdRoot || safeReal(cwdRoot) !== safeReal(projectRoot)) return null;
  return projectRoot;
}

/**
 * The main checkout and its dispatch board, taken from git and not from any
 * flag. The identity roster must be read from here: a path the caller chose is
 * a path the caller can forge. Null when the checkout cannot be verified.
 */
export function resolveTrustedBoard(
  cwd: string,
  run: GitRunner = runGit,
): { root: string; boardDir: string } | null {
  const root = trustedPolicyRoot(cwd, cwd, run);
  if (!root) return null;
  const real = safeReal(root);
  return { root: real, boardDir: path.join(real, '.ai-sdlc', 'dispatch') };
}
