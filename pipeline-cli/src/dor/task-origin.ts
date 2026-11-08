import { execFileSync } from 'node:child_process';
import { relative, isAbsolute, sep } from 'node:path';
import type { TaskOrigin } from './types.js';

const BASE_REFS = ['origin/main', 'main'];

function gitShow(workDir: string, ref: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Decide a task file's provenance (AISDLC-636.1). `'base-ref'` only when the file is present
 * on the base ref with byte-identical content; anything else (new in the PR tree, modified by
 * the PR, outside the repo, no git, no base ref) fails closed to `'pr-tree'`. The import path
 * never calls this: it passes `'import'` explicitly.
 */
export function resolveTaskOrigin(workDir: string, taskFile: string, raw: string): TaskOrigin {
  const rel = relative(workDir, taskFile);
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) return 'pr-tree';
  const relPath = rel.split(sep).join('/');
  for (const ref of BASE_REFS) {
    const base = gitShow(workDir, ref, relPath);
    if (base !== null) return base === raw ? 'base-ref' : 'pr-tree';
  }
  return 'pr-tree';
}
