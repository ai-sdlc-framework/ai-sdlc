import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Main checkout of the repository containing `cwd` (AISDLC-1010). A linked
 * worktree shares its `.git` common dir with the main checkout, so the parent
 * of that common dir is the root every session agrees on. Falls back to `cwd`
 * outside a git repository or for a bare layout.
 */
export function resolveMainCheckout(cwd: string): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const abs = resolve(cwd, common);
    return basename(abs) === '.git' ? dirname(abs) : cwd;
  } catch {
    return cwd;
  }
}

/**
 * Directory holding the landing-gate audit JSONL files. `$ARTIFACTS_DIR` (or an
 * explicit argument) overrides; otherwise `<main checkout>/artifacts/_governance`,
 * never the caller's working directory.
 */
export function auditGovernanceDir(artifactsDir?: string, cwd: string = process.cwd()): string {
  return join(
    artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(resolveMainCheckout(cwd), 'artifacts'),
    '_governance',
  );
}
