/**
 * Fallback for a judgment provider's credential (AISDLC-1442): when the provider's own
 * `requires.envVar` is not exported, read that one variable from the git-ignored
 * `<projectRoot>/.env`. Nothing else is read out of the file, nothing is written to
 * `process.env`, and the value is never logged. The project root is the main checkout
 * (the parent of the shared `.git` directory), so a task worktree finds the operator's
 * `.env`. Each file is read at most once per process.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Cache: `<root>\0<name>` → value, or undefined when the file or the variable is absent. */
const cache = new Map<string, string | undefined>();
/** Cache of the project root per working directory. */
const rootCache = new Map<string, string>();

/** The main checkout of the repository `dir` belongs to; `dir` itself when git cannot say. */
export function resolveEnvFileRoot(dir: string): string {
  const cached = rootCache.get(dir);
  if (cached !== undefined) return cached;
  let root = resolve(dir);
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (common && basename(common) === '.git') root = dirname(common);
  } catch {
    // not a repository or git missing: the directory itself
  }
  rootCache.set(dir, root);
  return root;
}

/**
 * The value of `name` on its own `NAME=value` line of the `.env` text, or undefined.
 * Lines are scanned as strings and only the matching one is parsed: no other variable
 * is ever read into an object.
 */
export function parseEnvFileKey(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    if (!line.startsWith(name)) continue;
    const rest = line.slice(name.length).trimStart();
    if (!rest.startsWith('=')) continue;
    let value = rest.slice(1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    found = value === '' ? undefined : value;
  }
  return found;
}

export interface EnvFileKeyOptions {
  /** Directory the project root is resolved from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Project root holding `.env`; skips the git lookup (tests). */
  projectRoot?: string;
}

/** `name` from `<projectRoot>/.env`, or undefined when absent or unreadable. Never throws. */
export function readEnvFileKey(name: string, opts: EnvFileKeyOptions = {}): string | undefined {
  try {
    const root = opts.projectRoot ?? resolveEnvFileRoot(opts.cwd ?? process.cwd());
    const cacheKey = `${root}\0${name}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let value: string | undefined;
    try {
      value = parseEnvFileKey(readFileSync(join(root, '.env'), 'utf8'), name);
    } catch {
      value = undefined;
    }
    cache.set(cacheKey, value);
    return value;
  } catch {
    return undefined;
  }
}

/** Drop the per-process cache (tests). */
export function clearEnvFileKeyCache(): void {
  cache.clear();
  rootCache.clear();
}
