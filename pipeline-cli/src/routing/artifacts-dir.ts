import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Artifacts directory for a worktree: explicit, then $ARTIFACTS_DIR, then the worktree's own. */
export function routingArtifactsDir(worktreePath: string, explicit?: string): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? join(worktreePath, '.ai-sdlc', 'artifacts');
}

/**
 * Whether the steps should record the resolution. A worktree that does not
 * exist on disk (a prompt-rendering call with a made-up path) never gets a
 * directory created for it.
 */
export function routingRecordable(worktreePath: string, explicit?: string): boolean {
  return explicit !== undefined || !!process.env.ARTIFACTS_DIR || existsSync(worktreePath);
}
