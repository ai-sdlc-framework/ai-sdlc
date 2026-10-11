import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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

/**
 * The project root a worktree belongs to: the parent of the shared `.git`
 * directory (`git rev-parse --path-format=absolute --git-common-dir`). A plain
 * checkout resolves to itself. When git cannot answer (not a repository, a bare
 * parent, git missing) the given directory is returned unchanged.
 */
export function resolveProjectRoot(dir: string): string {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (common && basename(common) === '.git') return dirname(common);
  } catch {
    // fall through to the directory itself
  }
  return resolve(dir);
}

/** Artifacts directory for a run: explicit, then $ARTIFACTS_DIR, then `<projectRoot>/.ai-sdlc/artifacts`. */
export function routingArtifactsDir(projectRoot: string, explicit?: string): string {
  return resolveArtifactsDir(projectRoot, explicit);
}

/**
 * Whether the steps should record the resolution. A worktree that does not
 * exist on disk (a prompt-rendering call with a made-up path) never gets a
 * directory created for it.
 */
export function routingRecordable(worktreePath: string, explicit?: string): boolean {
  return explicit !== undefined || !!process.env.ARTIFACTS_DIR || existsSync(worktreePath);
}
