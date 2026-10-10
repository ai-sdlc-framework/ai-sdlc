/**
 * Push-time scope gate (RFC-0053 OQ-1): a `protected` entry must never sit in the
 * tracked root, and the configured protected root must be git-ignored and untracked.
 * Uses the real frontmatter parser so flow-mapping, CRLF, BOM and comment forms
 * cannot slip past a line-regex.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DEFAULT_PROTECTED_ROOT, loadKnowledgeConfig, type KnowledgeConfig } from './config.js';
import { parseEntryFile } from './entry.js';

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...listMarkdown(full));
    else if (d.isFile() && d.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

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

/** A violation message when `text` (the content of tracked-root file `rel`) may be a protected entry. */
function entryScopeViolation(rel: string, text: string): string | null {
  const parsed = parseEntryFile(text);
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
  for (const file of listMarkdown(trackedAbs)) {
    const rel = relative(projectRoot, file);
    const v = entryScopeViolation(rel, readFileSync(file, 'utf-8'));
    if (v) violations.push(v);
  }

  const inRepo = git(projectRoot, ['rev-parse', '--git-dir']).ok;
  if (inRepo) {
    const root = config.protectedRoot.replace(/\/+$/, '');
    const tracked = git(projectRoot, ['ls-files', '-z', '--', root]);
    for (const f of tracked.out.split('\0').filter(Boolean)) {
      violations.push(`${f} (file under protected root is tracked by git)`);
    }
    // check-ignore exits 1 when the path is NOT ignored.
    const ignored = git(projectRoot, ['check-ignore', '-q', '--no-index', `${root}/.probe`]);
    if (!ignored.ok) {
      violations.push(`${root}/ (configured protected root is not git-ignored)`);
    }
  }
  return violations;
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
      } else if (trackedRoot && underRoot(path, trackedRoot) && path.endsWith('.md')) {
        const blob = git(projectRoot, ['cat-file', 'blob', newSha]);
        const v = blob.ok
          ? entryScopeViolation(path, blob.out)
          : `${path} (cannot read blob in pushed commit ${short}, cannot prove it is not protected)`;
        if (v) violations.push(blob.ok ? `${v} in pushed commit ${short}` : v);
      }
    }
  }
  return violations;
}
