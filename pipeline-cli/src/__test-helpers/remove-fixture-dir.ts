/**
 * Safe recursive teardown for test fixtures (AISDLC-1128).
 *
 * The 2026-10-30 incident: a teardown ran `rmSync(join(gitCommonDir, '..'),
 * { recursive: true })` where the path came from a git answer that a leaked
 * `GIT_DIR` had redirected to the real repository. Nothing checked where the
 * path pointed. Every fixture teardown calls this helper instead of `rmSync`;
 * it throws, deleting nothing, unless the path resolves strictly inside the
 * realpath of `tmpdir()`.
 */
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

function realOrResolved(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  // Nonexistent leaf: resolve the nearest existing ancestor and re-append the rest.
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return resolve(realOrResolved(parent), abs.slice(parent.length + 1));
}

export function removeFixtureDir(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('removeFixtureDir: refusing empty or non-string path');
  }
  const root = realpathSync(tmpdir());
  const target = realOrResolved(path);
  if (!target.startsWith(root + sep)) {
    throw new Error(`removeFixtureDir: refusing to delete ${target}; not strictly inside ${root}`);
  }
  rmSync(target, { recursive: true, force: true });
}
