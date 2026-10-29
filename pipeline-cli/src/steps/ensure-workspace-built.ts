/**
 * ensureWorkspaceBuilt (AISDLC-1111) - the tree that is signed and pushed is built from the
 * sources being pushed. A rebase invalidates the build made at setup, and a worktree installed
 * with `--ignore-scripts` never had one, so `attestation-sign` (needs
 * `orchestrator/dist/runtime/attestations.js`) and the pre-push build (needs a current
 * `reference/dist`) fail at the last step. Callers: Step 3 (setup and resume) and Step 11 (after
 * its late rebase, which also covers the fix-round resume).
 *
 * Rebuilds (`pnpm build`, topological) when a required dist entry point is absent, or when HEAD
 * differs from `changedSince` (default: the sha in `.ai-sdlc/.last-build-sha`) and from the
 * recorded build sha. The build sha is recorded after a successful build.
 *
 * @module steps/ensure-workspace-built
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';

/** Dist entry points the sign hook and the pre-push build read. */
export const REQUIRED_DIST_ENTRY_POINTS = [
  join('orchestrator', 'dist', 'runtime', 'attestations.js'),
  join('reference', 'dist', 'index.js'),
] as const;

export const LAST_BUILD_SHA_FILE = join('.ai-sdlc', '.last-build-sha');

export interface EnsureWorkspaceBuiltOptions {
  runner?: Runner;
  /** The HEAD the caller held before moving it; a different HEAD forces a rebuild. */
  changedSince?: string;
  /** Current HEAD when the caller already knows it; otherwise `git rev-parse HEAD`. */
  head?: string;
}

export interface EnsureWorkspaceBuiltResult {
  ok: boolean;
  built: boolean;
  reason?: string;
}

export async function ensureWorkspaceBuilt(
  worktreePath: string,
  opts: EnsureWorkspaceBuiltOptions = {},
): Promise<EnsureWorkspaceBuiltResult> {
  const runner = opts.runner ?? defaultRunner;
  const head =
    opts.head ??
    (
      await runner('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, allowFailure: true })
    ).stdout.trim();
  const shaPath = join(worktreePath, LAST_BUILD_SHA_FILE);
  const last = existsSync(shaPath) ? readFileSync(shaPath, 'utf8').trim() : '';
  const missing = REQUIRED_DIST_ENTRY_POINTS.filter((p) => !existsSync(join(worktreePath, p)));
  const moved = head !== (opts.changedSince ?? last) && head !== last;
  if (missing.length === 0 && !moved) return { ok: true, built: false };

  const build = await runner('pnpm', ['build'], {
    cwd: worktreePath,
    timeout: 600_000,
    allowFailure: true,
  });
  if (build.code !== 0) {
    const out = (build.stderr.trim() || build.stdout.trim() || 'unknown error').slice(-2000);
    return { ok: false, built: true, reason: `pnpm build failed in ${worktreePath}: ${out}` };
  }
  if (head) {
    mkdirSync(dirname(shaPath), { recursive: true });
    writeFileSync(shaPath, `${head}\n`);
  }
  return { ok: true, built: true };
}
