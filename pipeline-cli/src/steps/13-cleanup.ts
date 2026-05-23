/**
 * Step 13 — Cleanup the per-worktree `.active-task` sentinel + (AISDLC-393)
 * any transient gh-issue synthetic task file.
 *
 * Mirrors `execute-orchestrator.md` Step 13. Always runs (success, failure,
 * rollback, escalation) — closes the implicit try/finally started at Step 4.
 *
 * Only the per-worktree sentinel is touched. The legacy project-level
 * `.worktrees/.active-task` sentinel is no longer written by Step 4 (per
 * AISDLC-81), so we don't need to clean it up here either.
 *
 * AISDLC-393 round 2 (AC-2 fix) — also removes the transient synthetic task
 * file Step 4 materialises on the gh-issue path (when
 * `taskSpec.permittedExternalPaths` is non-empty). The file's path is
 * either passed in via `opts.syntheticTaskFile` (preferred — executePipeline
 * threads the path from Step 4's return) or re-derived from `opts.taskSpec`
 * via `syntheticTaskFilePath()` (so the cleanup is idempotent even when the
 * caller forgot to thread the path). Removal is best-effort: failures
 * surface as `syntheticTaskFileRemoved: false` rather than throwing.
 *
 * @module steps/13-cleanup
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticTaskFilePath } from './04-flip-status.js';
import type { CleanupOptions, CleanupResult } from '../types.js';

export async function cleanupTask(opts: CleanupOptions): Promise<CleanupResult> {
  const sentinelPath = join(opts.worktreePath, '.active-task');
  let sentinelRemoved = false;
  if (existsSync(sentinelPath)) {
    try {
      unlinkSync(sentinelPath);
      sentinelRemoved = true;
    } catch {
      // Defensive: if removal fails (race with another cleanup), report.
      sentinelRemoved = false;
    }
  }

  // AISDLC-393 (round 2, AC-2 fix) — remove the synthetic gh-issue task
  // file if one was materialised. Re-derive the path if the caller didn't
  // thread it through, so the cleanup is idempotent regardless of how
  // the call site is wired.
  let syntheticTaskFileRemoved = false;
  const syntheticPath = resolveSyntheticPath(opts);
  if (syntheticPath && existsSync(syntheticPath)) {
    try {
      unlinkSync(syntheticPath);
      syntheticTaskFileRemoved = true;
    } catch {
      syntheticTaskFileRemoved = false;
    }
  }

  return { sentinelRemoved, syntheticTaskFileRemoved };
}

function resolveSyntheticPath(opts: CleanupOptions): string | null {
  if (opts.syntheticTaskFile) return opts.syntheticTaskFile;
  if (opts.taskSpec && opts.taskSpec.permittedExternalPaths?.length) {
    return syntheticTaskFilePath(opts.worktreePath, opts.taskSpec);
  }
  return null;
}
