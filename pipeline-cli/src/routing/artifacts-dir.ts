import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Default project artifacts directory: `<projectRoot>/.ai-sdlc/artifacts` (gitignored runtime output). */
export function defaultArtifactsDir(projectRoot: string): string {
  return join(resolve(projectRoot), '.ai-sdlc', 'artifacts');
}

/**
 * The one place the artifacts directory is chosen: explicit, then $ARTIFACTS_DIR,
 * then the project default. The model resolver, the scorecard and replay all use it.
 */
export function resolveArtifactsDir(projectRoot: string, explicit?: string): string {
  return explicit ?? process.env.ARTIFACTS_DIR ?? defaultArtifactsDir(projectRoot);
}

/** Artifacts directory for a worktree: explicit, then $ARTIFACTS_DIR, then the worktree's own. */
export function routingArtifactsDir(worktreePath: string, explicit?: string): string {
  return resolveArtifactsDir(worktreePath, explicit);
}

/**
 * Whether the steps should record the resolution. A worktree that does not
 * exist on disk (a prompt-rendering call with a made-up path) never gets a
 * directory created for it.
 */
export function routingRecordable(worktreePath: string, explicit?: string): boolean {
  return explicit !== undefined || !!process.env.ARTIFACTS_DIR || existsSync(worktreePath);
}
