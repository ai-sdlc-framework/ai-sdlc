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

/** Strips leading and trailing slashes by index, never by a backtracking regex. */
function stripSlashes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '/') start++;
  while (end > start && text[end - 1] === '/') end--;
  return text.slice(start, end);
}

/**
 * `/.ai-sdlc/state/` and `.ai-sdlc/state` ignore the same thing as `.ai-sdlc/state/`.
 * Git drops trailing spaces from a pattern but keeps leading ones as part of it, so
 * only the end is trimmed.
 */
function normalize(line: string): string {
  return stripSlashes(line.trimEnd());
}

/**
 * True when git would ignore `entry` according to `gitignore`: some line names it and
 * no later line negates it (`!entry` re-includes the directory). A negation of a path
 * below an ignored directory has no effect in git, so it is not treated as one.
 */
export function gitignoreCovers(gitignore: string, entry: string): boolean {
  const wanted = normalize(entry);
  let covered = false;
  for (const line of gitignore.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      if (normalize(line.slice(1)) === wanted) covered = false;
    } else if (normalize(line) === wanted) {
      covered = true;
    }
  }
  return covered;
}

/** True when a non-negated line already writes `entry`, wherever it sits in the file. */
function gitignoreMentions(gitignore: string, entry: string): boolean {
  const wanted = normalize(entry);
  return gitignore
    .split('\n')
    .some((line) => !line.startsWith('!') && !line.startsWith('#') && normalize(line) === wanted);
}

/**
 * The runtime entries `gitignore` does not yet write, in list order. This asks "is it
 * written", not "does git effectively ignore it": a deliberate `!entry` line is left
 * for the operator (and for `doctor`, which does ask the second question), and adding
 * the entry again before that line would grow the file on every run without changing
 * what git ignores.
 */
export function missingRuntimeGitignorePaths(gitignore: string): string[] {
  return RUNTIME_GITIGNORE_PATHS.filter((entry) => !gitignoreMentions(gitignore, entry));
}

/** True when a whole line (ignoring surrounding whitespace) is the sentinel. */
export function hasSentinelLine(gitignore: string): boolean {
  return gitignore.split('\n').some((line) => line.trim() === RUNTIME_GITIGNORE_SENTINEL);
}

/**
 * Adds `missing` to the block that already follows the sentinel, so a repository
 * initialised before an entry existed gains it under the same heading. The block
 * is the run of non-blank, non-comment lines directly after the sentinel line.
 * Callers pick this path with `hasSentinelLine`, so the sentinel is always found.
 * Entries take the file's line ending (CRLF files stay CRLF).
 */
export function insertIntoSentinelBlock(gitignore: string, missing: readonly string[]): string {
  const lines = gitignore.split('\n');
  const at = lines.findIndex((line) => line.trim() === RUNTIME_GITIGNORE_SENTINEL);
  if (at === -1) return gitignore;
  const cr = lines[at].endsWith('\r') ? '\r' : '';
  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== '' && !lines[end].trim().startsWith('#')) {
    end++;
  }
  lines.splice(end, 0, ...missing.map((entry) => entry + cr));
  return lines.join('\n');
}
