/**
 * Stable repository identity for the usage ledger (AISDLC-653.1).
 *
 * A directory name is not an identity: two unrelated checkouts can share one.
 * `repoId` is the normalized `origin` URL joined with the repository's root
 * commit hash, `<host>/<path>#<root-commit>`. Credentials embedded in the
 * remote URL are dropped, so no secret reaches the ledger. A repository with
 * no `origin` remote uses the literal `local` in place of the URL. A repository
 * with no commits has no identity (`undefined`); its records carry the positive
 * marker `repoIdUnavailable` and are never matched by name (only records with
 * neither field predate this module and may use the labelled name fallback).
 * When history has several root commits the lexicographically smallest hash of
 * `HEAD`'s ancestry is used, so the choice is deterministic. That choice can
 * change if unrelated history (another root) is merged in with a smaller hash;
 * the consequence is only that earlier records stop matching (record loss), never
 * that another repository's records are matched (no contamination).
 *
 * @module usage/repo-id
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_URL = 200;
const GIT_TIMEOUT_MS = 5_000;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type GitRunner = (cwd: string, args: string[]) => string | undefined;

const STRIP_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
]);

/** The child environment for git: discovery and config overrides removed so an exported variable cannot redirect every checkout to one repository. */
export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (STRIP_ENV.has(k) || /^GIT_CONFIG_(KEY|VALUE)_/.test(k)) continue;
    out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/** Run git with an argv array (never a shell string); any failure yields undefined. */
const runGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(process.env),
    }).trim();
  } catch {
    return undefined;
  }
};

/** Percent-encode every byte outside the identity-safe set (lossless, unlike stripping). */
function encodeSafe(text: string): string {
  let out = '';
  for (const b of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._~:/-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Normalize a remote URL: drop any query or fragment, the scheme, `user:pass@`
 * credentials and a trailing `.git` and slashes; lower-case the host;
 * percent-encode (never strip) characters outside a path-safe set; bound the
 * length with a hash of the full value. Returns `local` for an empty URL, a
 * local path or `file://` URL, or one where an `@` survives authority handling
 * (a possible credential).
 */
export function normalizeRemoteUrl(raw: string | undefined): string {
  let u = (raw ?? '').trim();
  const cut = u.search(/[?#]/);
  if (cut !== -1) u = u.slice(0, cut);
  if (!u) return 'local';
  if (/^file:/i.test(u) || /^[/\\.~]/.test(u) || /^[A-Za-z]:[\\/]/.test(u)) return 'local';
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Credentials sit before the last `@` that precedes the first path slash.
  const slash = u.indexOf('/');
  const authority = slash === -1 ? u : u.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at !== -1) u = u.slice(at + 1);
  if (u.includes('@')) return 'local';
  // scp-like `host:path` becomes `host/path`; a `:port` is kept as is.
  const m = /^([^/:]+):(?!\d+(?:\/|$))(.*)$/.exec(u);
  if (m) u = `${m[1]}/${m[2]}`;
  const i = u.indexOf('/');
  const host = (i === -1 ? u : u.slice(0, i)).toLowerCase();
  const path = (i === -1 ? '' : u.slice(i)).replace(/\/+$/, '').replace(/\.git$/i, '');
  const full = encodeSafe(`${host}${path}`);
  if (!full) return 'local';
  if (full.length <= MAX_URL) return full;
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 16);
  return `${full.slice(0, MAX_URL - 17)}~${digest}`;
}

/** Successful results only: a failed lookup is retried on the next call. */
const cache = new Map<string, string>();

/**
 * The repository identity of the checkout at `root`, computed once per
 * directory and cached on success. `undefined` when `root` has no commits or git
 * fails; that outcome is not cached.
 */
export function repoIdFor(root: string, run: GitRunner = runGit): string | undefined {
  if (run === runGit) {
    const hit = cache.get(root);
    if (hit !== undefined) return hit;
  }
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
  if (run === runGit && id !== undefined) cache.set(root, id);
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
  /** Records whose repoId could not be computed at ingest; never matched. */
  unavailable: number;
}

interface Selectable {
  repo?: string;
  repoId?: string;
  repoIdUnavailable?: boolean;
}

/**
 * Keep records of one repository. A record with a `repoId` must equal the
 * identity's; a record marked `repoIdUnavailable` is never matched; only a record
 * with neither field (it predates repoId) falls back to the directory name.
 */
export function selectByRepo<T extends Selectable>(
  records: Iterable<T>,
  id: RepoIdentity,
): RepoSelection<T> {
  const out: T[] = [];
  let legacy = 0;
  let unavailable = 0;
  for (const r of records) {
    if (r.repoIdUnavailable === true) {
      unavailable++;
    } else if (r.repoId !== undefined) {
      if (id.repoId !== undefined && r.repoId === id.repoId) out.push(r);
    } else if (r.repo === id.repoName) {
      out.push(r);
      legacy++;
    }
  }
  return { records: out, legacy, unavailable };
}

/** One-line label for the legacy fallback, or an empty string when none applied. */
export function legacyNote(
  sel: Pick<RepoSelection<unknown>, 'legacy'> & { unavailable?: number },
): string {
  const parts: string[] = [];
  if (sel.legacy > 0) {
    parts.push(
      `${sel.legacy} record(s) predate repoId and were matched by directory name only (legacy fallback).`,
    );
  }
  if ((sel.unavailable ?? 0) > 0) {
    parts.push(
      `${sel.unavailable} record(s) had no computable repoId at ingest and were excluded (repoId unavailable).`,
    );
  }
  return parts.join('\n');
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
  const named = all.filter((r) => r.repo === arg && r.repoIdUnavailable !== true);
  const unavailable = all.filter((r) => r.repo === arg && r.repoIdUnavailable === true).length;
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
  const note = legacyNote({ legacy, unavailable });
  if (note) parts.push(note);
  return { records: named, line: parts.join('\n') };
}
