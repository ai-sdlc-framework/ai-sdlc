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

/** The file name asked about inside a directory entry. */
const DIRECTORY_PROBE = 'probe';

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  /** A pattern with a slash (other than a trailing one) matches from the repository root. */
  anchored: boolean;
  segments: string[];
}

function parseRule(raw: string): IgnoreRule | null {
  if (raw.trim() === '' || raw.startsWith('#')) return null;
  let text = raw.trimEnd();
  const negated = text.startsWith('!');
  if (negated) text = text.slice(1);
  const dirOnly = text.endsWith('/');
  const leadingSlash = text.startsWith('/');
  text = stripSlashes(text);
  if (text === '') return null;
  const segments = text.split('/').filter((segment) => segment !== '');
  return { negated, dirOnly, anchored: leadingSlash || segments.length > 1, segments };
}

/** One path component against one glob segment (`*` and `?`; `[...]` is not supported). */
function segmentMatches(glob: string, name: string): boolean {
  if (!glob.includes('*') && !glob.includes('?')) return glob === name;
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`).test(name);
}

/** Anchored match of `segments` against all of `path`; `**` spans zero or more components. */
function pathMatches(segments: readonly string[], path: readonly string[]): boolean {
  if (segments.length === 0) return path.length === 0;
  const [head, ...rest] = segments;
  if (head === '**') {
    // A trailing `/**` matches everything inside, never the directory itself.
    if (rest.length === 0) return path.length > 0;
    for (let skip = 0; skip <= path.length; skip++) {
      if (pathMatches(rest, path.slice(skip))) return true;
    }
    return false;
  }
  return path.length > 0 && segmentMatches(head, path[0]) && pathMatches(rest, path.slice(1));
}

function ruleMatches(rule: IgnoreRule, path: readonly string[], isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (!rule.anchored) return segmentMatches(rule.segments[0], path[path.length - 1]);
  return pathMatches(rule.segments, path);
}

/**
 * True when git would ignore `entry` according to the text of `gitignore`, read the way
 * git reads one root .gitignore: the last matching line decides, `!` re-includes, and a
 * path below an ignored directory stays ignored whatever a later `!` says. So `artifacts/`,
 * `.ai-sdlc/`, `.ai-sdlc/*` and `**\/artifacts/` all cover `.ai-sdlc/artifacts/`, while
 * `.ai-sdlc/*` followed by `!.ai-sdlc/artifacts` does not.
 *
 * This is the fallback for when git cannot be asked (`git check-ignore`, see
 * `gitCheckIgnoreArgs`). It differs from git in what it cannot see: `[...]` character
 * classes and `\` escapes in patterns, nested .gitignore files, `.git/info/exclude` and
 * the global excludes file.
 */
export function gitignoreCovers(gitignore: string, entry: string): boolean {
  const rules = gitignore
    .split('\n')
    .map(parseRule)
    .filter((rule): rule is IgnoreRule => rule !== null);
  const path = stripSlashes(entry)
    .split('/')
    .filter((part) => part !== '');
  if (path.length === 0) return false;
  // A directory entry counts as covered when what is written inside it is ignored, the
  // same question `gitCheckIgnoreArgs` asks git, so `artifacts/*` covers it too.
  if (entry.endsWith('/')) path.push(DIRECTORY_PROBE);
  for (let depth = 1; depth <= path.length; depth++) {
    const prefix = path.slice(0, depth);
    const isDir = depth < path.length;
    let ignored = false;
    for (const rule of rules) {
      if (ruleMatches(rule, prefix, isDir)) ignored = !rule.negated;
    }
    if (ignored) return true;
  }
  return false;
}

/**
 * Arguments for `git` that ask whether `entry` is ignored in the repository at `dir`:
 * exit 0 means ignored, 1 means not. `--no-index` ignores whether a file is tracked, the
 * empty `core.excludesFile` keeps one developer's global ignore from hiding a repository
 * that other clones would still commit. (`.git/info/exclude` still applies.) A directory
 * entry is probed through a file inside it, so `dir/*`-style patterns count.
 */
export function gitCheckIgnoreArgs(dir: string, entry: string): string[] {
  const probe = entry.endsWith('/') ? `${entry}${DIRECTORY_PROBE}` : entry;
  return [
    '-C',
    dir,
    '-c',
    'core.excludesFile=/dev/null',
    'check-ignore',
    '-q',
    '--no-index',
    '--',
    probe,
  ];
}

/** Maps a `git check-ignore -q` exit code to ignored / not ignored / could not tell. */
export function interpretCheckIgnoreExit(exitCode: number): boolean | null {
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  return null;
}

/** True when a non-negated line already writes `entry`, wherever it sits in the file. */
function gitignoreMentions(gitignore: string, entry: string): boolean {
  const wanted = normalize(entry);
  return gitignore
    .split('\n')
    .some((line) => !line.startsWith('!') && !line.startsWith('#') && normalize(line) === wanted);
}

/**
 * The runtime entries `gitignore` neither writes nor already gets ignored by a broader
 * line (`artifacts/`, `.ai-sdlc/*`), in list order. `ignoredByGit` is the caller's answer
 * from `git check-ignore` (null when it could not ask), which wins over the text reading.
 * An entry written with a deliberate `!entry` line after it counts as written and is left
 * for the operator: adding it again would grow the file on every run without changing
 * what git ignores.
 */
export function missingRuntimeGitignorePaths(
  gitignore: string,
  ignoredByGit?: (entry: string) => boolean | null,
): string[] {
  return RUNTIME_GITIGNORE_PATHS.filter((entry) => {
    if (gitignoreMentions(gitignore, entry)) return false;
    return !(ignoredByGit?.(entry) ?? gitignoreCovers(gitignore, entry));
  });
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
