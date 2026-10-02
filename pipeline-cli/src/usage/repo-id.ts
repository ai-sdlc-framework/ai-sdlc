/**
 * Stable repository identity for the usage ledger (AISDLC-653.1).
 *
 * A directory name is not an identity: two unrelated checkouts can share one.
 * `repoId` is the normalized `origin` URL joined with the repository's root
 * commit hash, `<host>/<path>#<root-commit>`. Credentials embedded in the
 * remote URL are dropped, so no secret reaches the ledger. A repository with
 * no `origin` remote uses the literal `local` in place of the URL. A repository
 * with no commits has no identity (`undefined`); its records stay name-only.
 * When history has several root commits the lexicographically smallest hash of
 * `HEAD`'s ancestry is used, so the choice is deterministic.
 *
 * @module usage/repo-id
 */

import { execFileSync } from 'node:child_process';

const MAX_URL = 200;
const GIT_TIMEOUT_MS = 5_000;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type GitRunner = (cwd: string, args: string[]) => string | undefined;

/** Run git with an argv array (never a shell string); any failure yields undefined. */
const runGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Normalize a remote URL: drop the scheme, any `user:pass@` credentials, a
 * trailing `.git` and slashes; lower-case the host; keep only a bounded set of
 * path-safe characters. Returns `local` for an empty or unusable URL.
 */
export function normalizeRemoteUrl(raw: string | undefined): string {
  let u = (raw ?? '').trim();
  if (!u) return 'local';
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Credentials sit before the last `@` that precedes the first path slash.
  const slash = u.indexOf('/');
  const authority = slash === -1 ? u : u.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at !== -1) u = u.slice(at + 1);
  // scp-like `host:path` becomes `host/path`; a `:port` is kept as is.
  const m = /^([^/:]+):(?!\d+(?:\/|$))(.*)$/.exec(u);
  if (m) u = `${m[1]}/${m[2]}`;
  const i = u.indexOf('/');
  const host = (i === -1 ? u : u.slice(0, i)).toLowerCase();
  const path = (i === -1 ? '' : u.slice(i)).replace(/\/+$/, '').replace(/\.git$/i, '');
  const out = `${host}${path}`.replace(/[^A-Za-z0-9._~:/-]/g, '').slice(0, MAX_URL);
  return out || 'local';
}

const cache = new Map<string, string | undefined>();

/**
 * The repository identity of the checkout at `root`, computed once per
 * directory and cached. `undefined` when `root` has no commits or git fails.
 */
export function repoIdFor(root: string, run: GitRunner = runGit): string | undefined {
  if (run === runGit && cache.has(root)) return cache.get(root);
  const roots = (run(root, ['rev-list', '--max-parents=0', 'HEAD']) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => HASH.test(l))
    .sort();
  let id: string | undefined;
  if (roots.length > 0) {
    const url = normalizeRemoteUrl(run(root, ['config', '--get', 'remote.origin.url']));
    id = `${url}#${roots[0]}`;
  }
  if (run === runGit) cache.set(root, id);
  return id;
}

export interface RepoIdentity {
  repoId?: string;
  repoName: string;
}

export interface RepoSelection<T> {
  records: T[];
  /** Records matched by directory name because they carry no `repoId`. */
  legacy: number;
}

interface Selectable {
  repo?: string;
  repoId?: string;
}

/**
 * Keep records of one repository. A record with a `repoId` must equal the
 * identity's; only a record without one falls back to the directory name.
 */
export function selectByRepo<T extends Selectable>(
  records: Iterable<T>,
  id: RepoIdentity,
): RepoSelection<T> {
  const out: T[] = [];
  let legacy = 0;
  for (const r of records) {
    if (r.repoId !== undefined) {
      if (id.repoId !== undefined && r.repoId === id.repoId) out.push(r);
    } else if (r.repo === id.repoName) {
      out.push(r);
      legacy++;
    }
  }
  return { records: out, legacy };
}

/** One-line label for the legacy fallback, or an empty string when none applied. */
export function legacyNote(sel: Pick<RepoSelection<unknown>, 'legacy'>): string {
  return sel.legacy > 0
    ? `${sel.legacy} record(s) predate repoId and were matched by directory name only (legacy fallback).`
    : '';
}

/**
 * Resolve `report --repo`: a `repoId` (contains `#`) matches exactly; a
 * directory name matches by the current checkout's identity when it names the
 * current checkout, else by every record of that name. Returns the records and
 * a line stating the repoId(s) resolved and any legacy fallback.
 */
export function resolveRepoFilter<T extends Selectable>(
  records: Iterable<T>,
  arg: string,
  current: RepoIdentity,
): { records: T[]; line: string } {
  const all = [...records];
  if (arg.includes('#')) {
    return { records: all.filter((r) => r.repoId === arg), line: `Repository: ${arg}` };
  }
  if (arg === current.repoName && current.repoId !== undefined) {
    const sel = selectByRepo(all, current);
    const note = legacyNote(sel);
    return {
      records: sel.records,
      line: `Repository: ${arg} -> repoId ${current.repoId}${note ? `\n${note}` : ''}`,
    };
  }
  const named = all.filter((r) => r.repo === arg);
  const ids = [...new Set(named.flatMap((r) => (r.repoId ? [r.repoId] : [])))].sort();
  const legacy = named.filter((r) => r.repoId === undefined).length;
  const parts: string[] = [];
  if (ids.length === 0) parts.push(`Repository: ${arg} -> no repoId recorded`);
  else if (ids.length === 1) parts.push(`Repository: ${arg} -> repoId ${ids[0]}`);
  else {
    parts.push(
      `Repository: ${arg} -> ${ids.length} repoIds (same directory name, different repositories); pass one as --repo to separate them:`,
      ...ids.map((i) => `  ${i}`),
    );
  }
  const note = legacyNote({ legacy });
  if (note) parts.push(note);
  return { records: named, line: parts.join('\n') };
}
