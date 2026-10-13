/**
 * AISDLC-825 — resolve the decision-catalog root.
 *
 * From a linked worktree (`.worktrees/<id>/`) the catalog root is the MAIN
 * checkout, so `cli-decisions add|answer|show|list` agree wherever they run and
 * dispatch (in the parent) can route a decision an executor filed from its
 * worktree. Outside a linked worktree the directory is returned unchanged.
 */
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveCatalogRoot(dir: string): string {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir || !common) return dir;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(gitDir) === real(common)) return dir; // not a linked worktree
  if (basename(common) !== '.git') return dir; // bare or unusual layout
  return dirname(common);
}
