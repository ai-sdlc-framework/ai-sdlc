/**
 * Push-time scope gate (RFC-0053 OQ-1): a `protected` entry must never sit in the
 * tracked root, and the configured protected root must be git-ignored and untracked.
 * Uses the real frontmatter parser so flow-mapping, CRLF, BOM and comment forms
 * cannot slip past a line-regex.
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import {
  DEFAULT_KNOWLEDGE_BACKEND,
  DEFAULT_PROTECTED_ROOT,
  loadKnowledgeConfig,
  type KnowledgeConfig,
} from './config.js';
import { parseEntryFile } from './entry.js';
import {
  backendSelection,
  openKnowledgeStore,
  resolveKnowledgeBackend,
  type KnowledgeStore,
  type RawStoredEntry,
} from './knowledge-store.js';

function git(projectRoot: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return { ok: false, out: status === undefined ? 'error' : String(status) };
  }
}

/** A violation message when tracked-root file `rel` (as parsed) may be a protected entry. */
function entryScopeViolation(rel: string, parsed: RawStoredEntry['parsed']): string | null {
  if ('error' in parsed) {
    // A file with no frontmatter is not an entry; anything else unparseable fails closed.
    if (parsed.error !== 'missing YAML frontmatter') {
      return `${rel} (unparseable frontmatter, cannot prove it is not protected)`;
    }
    return null;
  }
  const scope = parsed.fields.scope;
  if (typeof scope === 'string') {
    return scope.trim().toLowerCase() === 'protected'
      ? `${rel} (scope: protected in tracked root)`
      : null;
  }
  return scope != null ? `${rel} (non-string scope, cannot prove it is not protected)` : null;
}

/** Returns human-readable violations; empty means the gate passes. */
export function checkKnowledgeScope(
  projectRoot: string,
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): string[] {
  const violations: string[] = [];
  const trackedAbs = isAbsolute(config.trackedRoot)
    ? config.trackedRoot
    : join(projectRoot, config.trackedRoot);
  const store = openKnowledgeStore(
    { ...backendSelection(config), trackedRoot: trackedAbs },
    projectRoot,
  );
  for (const { path, parsed } of store.listRaw('tracked')) {
    const v = entryScopeViolation(relative(projectRoot, join(trackedAbs, path)), parsed);
    if (v) violations.push(v);
  }

  const inRepo = git(projectRoot, ['rev-parse', '--git-dir']).ok;
  // A protected root outside the repository cannot be tracked or committed by it.
  const root = toRepoRelative(projectRoot, config.protectedRoot);
  if (inRepo && root !== null) {
    violations.push(
      ...leakViolations(projectRoot, root, 'protected root', 'configured protected root'),
    );
  }
  // AISDLC-1433: where the backend keeps content locally gets the protected-root rules.
  const local = declaredLocalPaths(store);
  if ('error' in local) violations.push(local.error);
  for (const p of inRepo && !('error' in local) ? local.paths : []) {
    const rel = toRepoRelative(projectRoot, p);
    if (rel === null) continue;
    violations.push(
      ...leakViolations(
        projectRoot,
        rel,
        'knowledge backend local path',
        'knowledge backend local path',
      ),
    );
  }
  return violations;
}

/** Tracked files under `root`, and `root` not git-ignored (`root` is repo-relative). */
function leakViolations(projectRoot: string, root: string, under: string, label: string): string[] {
  const violations: string[] = [];
  const tracked = git(projectRoot, ['ls-files', '-z', '--', root]);
  if (!tracked.ok) {
    violations.push(`${root}/ (cannot list tracked files, git exited ${tracked.out})`);
  }
  for (const f of tracked.ok ? tracked.out.split('\0').filter(Boolean) : []) {
    violations.push(`${f} (file under ${under} is tracked by git)`);
  }
  if (!isIgnored(projectRoot, root)) {
    violations.push(`${root}/ (${label} is not git-ignored)`);
  }
  return violations;
}

/** Whether `root` (repo-relative file or directory) is git-ignored; a probe below it covers both. */
function isIgnored(projectRoot: string, root: string): boolean {
  // check-ignore exits 1 when the path is NOT ignored.
  return git(projectRoot, ['check-ignore', '-q', '--no-index', `${root}/.probe`]).ok;
}

/** The store's declared local paths; a backend that throws fails the gate closed. */
function declaredLocalPaths(store: KnowledgeStore): { paths: string[] } | { error: string } {
  try {
    const paths = store.localPaths?.() ?? [];
    return { paths: paths.filter((p) => typeof p === 'string' && p !== '') };
  } catch (err) {
    return {
      error: `knowledge backend '${store.kind}' localPaths() threw (${
        err instanceof Error ? err.message : String(err)
      }), cannot prove its local content is not committed`,
    };
  }
}

function toRepoRelative(projectRoot: string, root: string): string | null {
  const rel = (isAbsolute(root) ? relative(projectRoot, root) : root).replace(/\\/g, '/');
  const trimmed = rel.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed.startsWith('..') ? null : trimmed;
}

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Scans every commit selected by `revs` (arguments to `git rev-list`, e.g.
 * `['<local-sha>', '^<remote-sha>']`) so a protected entry that is added in one
 * pushed commit and removed in a later one is still caught: the gate looks at the
 * pushed history, not at HEAD or the index. Fails closed when the range cannot be read.
 */
export function checkKnowledgeScopeRange(
  projectRoot: string,
  revs: string[],
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): string[] {
  if (revs.length === 0 || revs.some((r) => r === '' || r.startsWith('-'))) {
    return ['push range is empty or malformed, cannot prove it adds no protected knowledge'];
  }
  const commits = git(projectRoot, ['rev-list', ...revs, '--']);
  if (!commits.ok) {
    return [`cannot list commits in push range (${revs.join(' ')}), cannot prove it is clean`];
  }
  const trackedRoot = toRepoRelative(projectRoot, config.trackedRoot);
  const protectedRoots = [
    ...new Set(
      [config.protectedRoot, DEFAULT_PROTECTED_ROOT]
        .map((r) => toRepoRelative(projectRoot, r))
        .filter((r): r is string => r !== null),
    ),
  ];
  const violations: string[] = [];
  // AISDLC-1433: a non-files backend may keep content locally; none of it may be pushed.
  const localRoots: string[] = [];
  if (config.backend !== DEFAULT_KNOWLEDGE_BACKEND) {
    const local = declaredLocalPaths(openKnowledgeStore(config, projectRoot));
    if ('error' in local) violations.push(local.error);
    else {
      localRoots.push(
        ...local.paths
          .map((p) => toRepoRelative(projectRoot, p))
          .filter((r): r is string => r !== null),
      );
    }
  }
  const seen = new Set<string>();
  for (const commit of commits.out.split('\n').filter(Boolean)) {
    const tree = git(projectRoot, [
      'diff-tree',
      '-r',
      '-z',
      '-m',
      '--root',
      '--no-renames',
      '--no-commit-id',
      '--diff-filter=AMT',
      commit,
    ]);
    if (!tree.ok) {
      violations.push(`${commit.slice(0, 12)} (cannot read commit, cannot prove it is clean)`);
      continue;
    }
    const parts = tree.out.split('\0').filter(Boolean);
    // Raw -z output alternates `:<modes> <shas> <status>` and `<path>`.
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i]!.split(' ');
      const newSha = meta[3] ?? '';
      const path = parts[i + 1]!;
      const key = `${newSha}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const short = commit.slice(0, 12);
      if (protectedRoots.some((r) => underRoot(path, r))) {
        violations.push(`${path} (file under protected root is in pushed commit ${short})`);
      } else if (localRoots.some((r) => underRoot(path, r))) {
        violations.push(
          `${path} (file under knowledge backend local path is in pushed commit ${short})`,
        );
      } else if (trackedRoot && underRoot(path, trackedRoot) && path.endsWith('.md')) {
        const blob = git(projectRoot, ['cat-file', 'blob', newSha]);
        const v = blob.ok
          ? entryScopeViolation(path, parseEntryFile(blob.out))
          : `${path} (cannot read blob in pushed commit ${short}, cannot prove it is not protected)`;
        if (v) violations.push(blob.ok ? `${v} in pushed commit ${short}` : v);
      }
    }
  }
  return violations;
}

/** One declared local path of the backend and whether git ignores it. */
export interface BackendLocalPathReport {
  path: string;
  /** False when the path is outside the repository (it cannot be committed; not checked). */
  inRepo: boolean;
  ignored: boolean;
}

/** What `cli-context check-backend` reports and the `knowledge-backend` doctor check maps. */
export interface KnowledgeBackendReport {
  backend: string;
  backendModule: string | null;
  /** The backend module loaded and the backend is registered (always true for files). */
  resolved: boolean;
  /** The registered factory returned a store (always true for files). */
  opened: boolean;
  /** Why resolving or opening failed, or why `localPaths()` could not be read. */
  error: string | null;
  localPaths: BackendLocalPathReport[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Whether the configured backend resolves, its factory opens, and each path it declares in
 * `localPaths()` is git-ignored (AISDLC-1433). Never throws for a backend failure; the
 * report carries it.
 */
export function checkKnowledgeBackend(
  projectRoot: string,
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): KnowledgeBackendReport {
  const report: KnowledgeBackendReport = {
    backend: config.backend,
    backendModule: config.backendModule,
    resolved: false,
    opened: false,
    error: null,
    localPaths: [],
  };
  try {
    resolveKnowledgeBackend(config, projectRoot);
  } catch (err) {
    return { ...report, error: message(err) };
  }
  report.resolved = true;
  let store: KnowledgeStore;
  try {
    store = openKnowledgeStore(config, projectRoot);
  } catch (err) {
    return { ...report, error: message(err) };
  }
  report.opened = true;
  const local = declaredLocalPaths(store);
  if ('error' in local) return { ...report, error: local.error };
  const inRepo = git(projectRoot, ['rev-parse', '--git-dir']).ok;
  report.localPaths = local.paths.map((path) => {
    const rel = inRepo ? toRepoRelative(projectRoot, path) : null;
    return { path, inRepo: rel !== null, ignored: rel !== null && isIgnored(projectRoot, rel) };
  });
  return report;
}
