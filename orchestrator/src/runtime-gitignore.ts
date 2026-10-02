/**
 * The .gitignore entries every AI-SDLC repository needs for its runtime output.
 *
 * `init` writes them when it scaffolds a repository and `execute` repairs them on
 * every run, so both must agree on the list; `doctor` reports a repository that
 * lacks the artifacts entry. This module only holds the list and the pure text
 * logic. Each caller keeps its own file I/O.
 */

/** Marks the block this tool owns, so a repeated run never writes a second one. */
export const RUNTIME_GITIGNORE_SENTINEL = '# ai-sdlc:runtime-gitignore';

/**
 * `.ai-sdlc/artifacts/` is the shared runtime output directory of the model
 * resolver, the scorecard and the replay commands (RFC-0050, AISDLC-657.2):
 * evidence files, assignment logs and replay results that must never be committed.
 */
export const ARTIFACTS_GITIGNORE_ENTRY = '.ai-sdlc/artifacts/';

export const RUNTIME_GITIGNORE_PATHS: readonly string[] = [
  '.ai-sdlc/state.db',
  '.ai-sdlc/state/',
  '.ai-sdlc/audit.jsonl',
  ARTIFACTS_GITIGNORE_ENTRY,
];

/** `/.ai-sdlc/state/` and `.ai-sdlc/state` ignore the same thing as `.ai-sdlc/state/`. */
function normalize(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** True when some line of `gitignore` already ignores `entry` (trailing/leading slash agnostic). */
export function gitignoreCovers(gitignore: string, entry: string): boolean {
  const wanted = normalize(entry);
  return gitignore.split('\n').some((line) => normalize(line) === wanted);
}

/** The runtime entries `gitignore` does not yet cover, in list order. */
export function missingRuntimeGitignorePaths(gitignore: string): string[] {
  return RUNTIME_GITIGNORE_PATHS.filter((entry) => !gitignoreCovers(gitignore, entry));
}

/**
 * Adds `missing` to the block that already follows the sentinel, so a repository
 * initialised before an entry existed gains it under the same heading. The block
 * is the run of non-blank, non-comment lines directly after the sentinel line.
 */
export function insertIntoSentinelBlock(gitignore: string, missing: readonly string[]): string {
  const lines = gitignore.split('\n');
  const at = lines.findIndex((line) => line.trim() === RUNTIME_GITIGNORE_SENTINEL);
  if (at === -1) return gitignore;
  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== '' && !lines[end].trim().startsWith('#')) {
    end++;
  }
  lines.splice(end, 0, ...missing);
  return lines.join('\n');
}
