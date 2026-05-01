/**
 * Step 13 — Cleanup the per-worktree `.active-task` sentinel.
 *
 * Mirrors `execute-orchestrator.md` Step 13. Always runs (success, failure,
 * rollback, escalation) — closes the implicit try/finally started at Step 4.
 *
 * Only the per-worktree sentinel is touched. The legacy project-level
 * `.worktrees/.active-task` sentinel is no longer written by Step 4 (per
 * AISDLC-81), so we don't need to clean it up here either.
 *
 * @module steps/13-cleanup
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CleanupOptions, CleanupResult } from '../types.js';

export async function cleanupTask(opts: CleanupOptions): Promise<CleanupResult> {
  const sentinelPath = join(opts.worktreePath, '.active-task');
  if (!existsSync(sentinelPath)) {
    return { sentinelRemoved: false };
  }
  try {
    unlinkSync(sentinelPath);
    return { sentinelRemoved: true };
  } catch {
    // Defensive: if removal fails (race with another cleanup), just report it.
    return { sentinelRemoved: false };
  }
}
