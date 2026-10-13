/**
 * Guarded `cli-dispatch release` (AISDLC-800).
 *
 * A release hands the claim back to `queue/`, and the next claimant starts from
 * the task's worktree. Work that exists only in that worktree (a commit that was
 * never pushed, an uncommitted edit to a tracked file) is lost or stranded when
 * the claim moves on. The release therefore refuses while the worktree holds
 * such work, unless the caller passes `--force --reason <text>`; a forced release
 * writes the reason (and what was found) to the manifest's `releaseHistory`.
 */

import { existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { now as clockNow } from '../clock.js';
import { runGit, type GitRunner } from '../hierarchy/trusted-root.js';
import { manifestPathIn, readInflightManifest, releaseInflight } from './board.js';
import type { DispatchManifest } from './types.js';
import { oneLine } from './verdict-fields.js';

/** Longest reason accepted for a forced release, in characters. */
export const MAX_RELEASE_REASON_CHARS = 500;

/** Inputs of {@link guardedRelease}. */
export interface GuardedReleaseOptions {
  /** Repository root the manifest's `worktree` path is relative to. */
  workDir: string;
  force?: boolean;
  reason?: string;
  /** Who releases (audit only). */
  by?: string;
  git?: GitRunner;
  now?: () => Date;
}

/** Result of {@link guardedRelease}. */
export interface GuardedReleaseResult {
  released: boolean;
  forced?: boolean;
  /** What the guard found when the release was forced. */
  unsafe?: string;
}

/**
 * Describe the work in the task's worktree that a release would strand, or
 * undefined when there is none (or no worktree to inspect).
 */
export function findStrandedWork(
  manifest: DispatchManifest,
  workDir: string,
  git: GitRunner = runGit,
): string | undefined {
  const base = path.resolve(workDir, '.worktrees');
  const worktree = path.resolve(workDir, manifest.worktree);
  if (!worktree.startsWith(base + path.sep)) {
    throw new Error(
      `${manifest.taskId}: the manifest worktree '${oneLine(manifest.worktree, 120)}' is outside .worktrees/; refusing to inspect it`,
    );
  }
  for (const [label, value] of [
    ['branch', manifest.branch],
    ['baseSha', manifest.baseSha],
  ] as const) {
    if (typeof value !== 'string' || value.startsWith('-')) {
      throw new Error(`${manifest.taskId}: the manifest ${label} is not a valid git ref`);
    }
  }
  if (!existsSync(worktree)) return undefined;
  const problems: string[] = [];
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], worktree);
  if (dirty) {
    const n = dirty.split('\n').filter((l) => l.trim().length > 0).length;
    problems.push(`${n} uncommitted change${n === 1 ? '' : 's'} to tracked files`);
  }
  // Commits not on the pull request head: compare with the pushed branch, or
  // with the base commit when the branch was never pushed.
  const remoteRef = `refs/remotes/origin/${manifest.branch}`;
  const pushed = git(['rev-parse', '--verify', '--quiet', remoteRef], worktree);
  const since = pushed ? remoteRef : manifest.baseSha;
  const ahead = git(['rev-list', '--count', `${since}..HEAD`], worktree);
  const count = ahead === null ? 0 : Number.parseInt(ahead, 10);
  if (Number.isFinite(count) && count > 0) {
    problems.push(
      `${count} commit${count === 1 ? '' : 's'} not on ${pushed ? `origin/${manifest.branch}` : 'any pushed branch'}`,
    );
  }
  return problems.length > 0 ? problems.join(' and ') : undefined;
}

/**
 * Release an inflight claim after checking its worktree.
 * @throws, releasing nothing, when the worktree holds unpushed or uncommitted
 *   work and `force` with a `reason` was not given, or when `force` has no reason.
 */
export function guardedRelease(
  boardDir: string,
  taskId: string,
  opts: GuardedReleaseOptions,
): GuardedReleaseResult {
  const manifest = readInflightManifest(boardDir, taskId);
  if (!manifest) return { released: releaseInflight(boardDir, taskId) };
  const reason = oneLine(opts.reason ?? '', MAX_RELEASE_REASON_CHARS);
  if (opts.force && reason.length === 0) {
    throw new Error('--force needs --reason <text>: say why the work in the worktree may be left');
  }
  const unsafe = findStrandedWork(manifest, opts.workDir, opts.git);
  if (unsafe && !opts.force) {
    throw new Error(
      `${taskId}: the worktree ${manifest.worktree} holds ${unsafe}; releasing would strand it. ` +
        `Commit and push it, or release with --force --reason <text>`,
    );
  }
  if (opts.force) {
    const at = (opts.now ?? clockNow)().toISOString();
    const entry = {
      at,
      ...(opts.by ? { by: oneLine(opts.by, 80) } : {}),
      reason,
      forced: true as const,
      ...(unsafe ? { unsafe } : {}),
    };
    const next: DispatchManifest = {
      ...manifest,
      releaseHistory: [...(manifest.releaseHistory ?? []), entry].slice(-20),
    };
    const target = manifestPathIn(boardDir, 'inflight', taskId);
    const tmp = `${target}.tmp-${process.pid}-${clockNow().getTime()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    renameSync(tmp, target);
  }
  const released = releaseInflight(boardDir, taskId);
  return {
    released,
    ...(opts.force ? { forced: true } : {}),
    ...(unsafe && opts.force ? { unsafe } : {}),
  };
}
