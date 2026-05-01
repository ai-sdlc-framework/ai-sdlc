/**
 * git remote parsing — extract org/repo from `git remote get-url origin`
 * to substitute into pipeline.yaml during init.
 *
 * Why this exists: AISDLC-78 — fresh installs got a literal `your-org`
 * placeholder in their pipeline.yaml, which made the file unrunnable
 * until the user noticed and edited it. We auto-detect the org/repo
 * from the git remote and only fall back to placeholders when no
 * remote is configured (e.g. a brand-new local-only repo).
 */

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export interface RemoteInfo {
  /** Organization or user name. */
  org: string;
  /** Repository name (without `.git` suffix). */
  repo: string;
  /** Whether the values came from a real git remote (vs the fallback). */
  detected: boolean;
}

const FALLBACK: RemoteInfo = { org: 'your-org', repo: 'your-repo', detected: false };

/**
 * Parse a single remote URL into org/repo. Supports:
 *  - https://github.com/foo/bar.git
 *  - https://github.com/foo/bar
 *  - git@github.com:foo/bar.git
 *  - ssh://git@github.com/foo/bar.git
 *  - git@gitlab.example.com:group/subgroup/repo.git (org=group, repo=repo)
 */
export function parseRemoteUrl(url: string): RemoteInfo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH shorthand: git@host:org/repo.git
  const sshShort = /^[^@\s]+@[^:\s]+:(.+?)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (sshShort) {
    return { org: sshShort[1].split('/').slice(-1)[0], repo: sshShort[2], detected: true };
  }

  // SSH or HTTPS with a scheme
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed) {
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const repo = segments[segments.length - 1];
      const org = segments[segments.length - 2];
      return { org, repo, detected: true };
    }
  }

  return null;
}

export interface DetectRemoteOptions {
  /** Override `execSync` for tests. */
  execImpl?: (
    cmd: string,
    opts: {
      cwd: string;
      encoding: 'utf-8';
      stdio: unknown;
    },
  ) => string;
  /** Project directory (defaults to process.cwd). */
  cwd?: string;
}

/**
 * Detect the GitHub-style org/repo from the project's git origin remote.
 * Returns FALLBACK with detected=false when no remote is configured or
 * when the URL cannot be parsed.
 *
 * The git invocation is hardened against two failure modes (AISDLC-104):
 *
 *  1. **cwd inheritance race under parallel test workers.** Every git
 *     command uses `git -C <cwd>` so the working dir is pinned at the
 *     git argv level rather than relying solely on `child_process`
 *     honouring the `cwd:` spawn option. Both should agree, but `git -C`
 *     is a git-internal contract independent of any subprocess cwd
 *     inheritance race that can happen when `process.chdir()` is
 *     interleaved with subprocess spawn under thread/fork pools.
 *
 *  2. **Host-repo origin bleed via parent-directory walk-up.** If `cwd`
 *     contains an invalid `.git` (e.g. an empty directory left by an
 *     init test setup) git normally walks UP looking for a real `.git`
 *     and can resolve to an ancestor repository — i.e. when run from
 *     inside the ai-sdlc-framework checkout the test would silently see
 *     the framework's own origin rather than the fallback. We defend by
 *     calling `git rev-parse --show-toplevel` first and confirming the
 *     reported toplevel matches `cwd` (after symlink resolution). When
 *     it doesn't, we treat the directory as not-a-repo and return the
 *     fallback rather than reporting the ancestor's remote. This was
 *     preferred over `GIT_CEILING_DIRECTORIES` because the ceiling-list
 *     semantics only block walking INTO the listed dirs, not up FROM
 *     them — empirically `GIT_CEILING_DIRECTORIES=<cwd>` did not stop
 *     git from finding a parent repo.
 */
export function detectGitRemote(opts: DetectRemoteOptions = {}): RemoteInfo {
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.execImpl ?? defaultExec;

  // Step 1: confirm cwd is a real git repo whose toplevel IS cwd.
  // If `git rev-parse --show-toplevel` errors OR returns an ancestor,
  // treat as not-a-repo and return FALLBACK. This is the host-repo
  // bleed defense: an empty/invalid `.git/` in cwd causes git to walk
  // UP to a parent repo, and `--show-toplevel` then reports the parent
  // — comparing realpaths catches it.
  let toplevel: string;
  try {
    toplevel = exec(`git -C ${shellQuote(cwd)} rev-parse --show-toplevel`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return FALLBACK;
  }
  if (!sameDir(toplevel, cwd)) {
    // git resolved to an ancestor repository — host-repo bleed. The
    // operator is in a directory that isn't itself a real git root, so
    // we deliberately do NOT report the ancestor's origin; emit
    // FALLBACK so init prints the explicit "no git origin remote
    // detected" message and substitutes `your-org`.
    return FALLBACK;
  }

  // Step 2: ask for the origin URL. If unset (no remote configured)
  // or unparseable, fall back.
  let url: string;
  try {
    url = exec(`git -C ${shellQuote(cwd)} remote get-url origin`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return FALLBACK;
  }
  const parsed = parseRemoteUrl(url);
  return parsed ?? FALLBACK;
}

/**
 * Compare two filesystem paths after symlink + canonicalization to
 * decide whether they refer to the same directory. macOS aliases /tmp
 * to /private/tmp, so a string compare of `cwd` against the toplevel
 * git reports would otherwise fail spuriously. Falls back to literal
 * compare when realpath isn't available (deleted dir, permission).
 */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(a) === norm(b);
}

/**
 * Quote a path for safe single-token interpolation into a shell command.
 * Wraps in single quotes and escapes any embedded single quotes by
 * closing the quote, emitting an escaped quote, then reopening.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultExec(
  cmd: string,
  opts: {
    cwd: string;
    encoding: 'utf-8';
    stdio: unknown;
  },
): string {
  return execSync(cmd, {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio: opts.stdio as Parameters<typeof execSync>[1] extends infer T
      ? T extends { stdio?: infer S }
        ? S
        : never
      : never,
  });
}

/**
 * Substitute `your-org` (and optionally `your-repo`) placeholders in a
 * template body with detected values.
 */
export function applyRemoteToPipelineYaml(template: string, info: RemoteInfo): string {
  // Replace the literal `org: your-org` config line with the detected
  // org. We deliberately match the exact YAML key shape rather than a
  // bare token so we don't smear the placeholder if it appears elsewhere.
  let out = template.replace(/(\borg:\s*)your-org(\b)/g, `$1${info.org}$2`);
  // If the template ever introduces a repo: placeholder, substitute it too.
  out = out.replace(/(\brepo:\s*)your-repo(\b)/g, `$1${info.repo}$2`);
  return out;
}
