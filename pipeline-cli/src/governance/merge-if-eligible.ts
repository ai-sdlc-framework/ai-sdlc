/**
 * `merge-if-eligible` — deterministic merge gate (RFC-0048 Phase 3 / AISDLC-603).
 *
 * The green+CLEAN merge gate MUST live in a deterministic CLI helper, never
 * in LLM-honored command-body prose. This module is that helper's core: it
 * reads the repo's `spec.governance` policy, evaluates a PR's real check state
 * + `mergeStateStatus` + provenance against that policy, and refuses (with an
 * auditable reason) unless every condition holds.
 *
 * Design decisions:
 *
 *  - **Trust is derived from GitHub data, not from `sourceKind` alone.** On top
 *    of the caller-supplied `sourceKind` (kept as an additional input), the
 *    helper requires facts read from the PR itself: same-repo (not a fork),
 *    base branch `main`, an author on the policy's `mergeAuthors` allow-list,
 *    a head commit authored by an allow-listed login, and a matching backlog
 *    task (see `evaluatePrTrust`).
 *  - **Policy comes from GitHub, not from local state.** The policy, allow-list,
 *    `task_prefix` and the task-file existence check are read from the
 *    repository's `main` as GitHub serves it (`gh api .../contents/...?ref=main`
 *    and the git trees API), against the same slug as the PR, so a forged local
 *    ref, a worktree copy, an uncommitted edit or a git environment variable
 *    has no effect, and a revocation on main applies immediately. The resolver
 *    is implemented natively here: no plugin file chosen through an environment
 *    variable is loaded. A verified main checkout is still required as an extra
 *    anchor for the repository slug. There is no argv or environment override;
 *    tests inject one programmatically through the exported builder.
 *  - **Checks are bound to the head commit.** The check runs and statuses are
 *    queried for the exact `headRefOid` read from the PR, the head is re-read
 *    before merging, and the merge itself carries `--match-head-commit`.
 *  - **Fail-closed on every axis.** An unreadable/malformed policy resolves to
 *    `STRICT_DEFAULTS`. A `sourceKind` that isn't literally `'backlog'` is
 *    untrusted. An empty checks list is refused, never vacuously green.
 *  - **All GitHub/git calls go through the injectable `Runner` seam**, so
 *    hermetic tests never touch the network.
 *
 * Residuals (also in docs/api-reference/governance.md): this is a local CLI,
 * so an agent that can edit the CLI/plugin code in its own checkout is not
 * bound by it; GitHub-side protections remain essential.
 *
 * @module governance/merge-if-eligible
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Runner } from '../runtime/exec.js';

// ── Governance policy types (mirrors ai-sdlc-plugin/hooks/lib/governance-resolver.js) ──

export type AllowMerge = 'never' | 'onGreenClean';

export interface GovernancePolicy {
  allowMerge: AllowMerge;
  allowForcePush: boolean;
  allowClosePrIssue: boolean;
  allowBranchDelete: boolean;
  allowResetHard: boolean;
}

/** Fail-closed default — byte-identical to AISDLC-601's `STRICT_DEFAULTS`. */
export const STRICT_DEFAULTS: GovernancePolicy = Object.freeze({
  allowMerge: 'never',
  allowForcePush: false,
  allowClosePrIssue: false,
  allowBranchDelete: false,
  allowResetHard: false,
});

// ── Verified main checkout (native; never loads plugin code) ────────────

/** Sync git runner used only to verify the main checkout; null on any failure. */
export type GitSync = (args: string[], cwd: string) => string | null;

/** Environment variables that can redirect or forge git's view of a repository. */
const GIT_REDIRECT_ENV = [
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_REPLACE_REF_BASE',
];

/** `process.env` without the git-redirecting variables (defense in depth). */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_REDIRECT_ENV) delete env[key];
  return env;
}

const defaultGitSync: GitSync = (args, cwd) => {
  try {
    return (
      execFileSync('git', ['--no-replace-objects', ...args], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        env: cleanGitEnv(),
      }).trim() || null
    );
  } catch {
    return null;
  }
};

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Main checkout root of the repo `dir` belongs to: the parent of the git COMMON
 * dir, accepted only when `<root>/.git` is a real directory (not a file or
 * symlink: the `.git` file / gitdir / commondir chain of a worktree is
 * writable by the governed agent). Anything else returns null (fail closed).
 */
export function verifiedMainRoot(dir: string, git: GitSync = defaultGitSync): string | null {
  const common = git(['rev-parse', '--git-common-dir'], dir);
  if (!common) return null;
  const dotGit = resolve(dir, common);
  if (basename(dotGit) !== '.git') return null;
  try {
    const st = lstatSync(dotGit);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return dirname(dotGit);
}

export interface TrustedRootResult {
  /** The verified main checkout, or `null` when none could be established. */
  root: string | null;
  /** Why `root` is null (empty when it is set). */
  reason: string;
}

/**
 * Establish the trusted root: the MAIN checkout of the repo that contains the
 * running CLI (`anchorDir`), which must be the SAME main checkout the
 * invocation's `cwd` belongs to, otherwise an agent could `cd` into a repo it
 * controls. A missing or unverifiable root yields `root: null` (refuse). There
 * is deliberately no flag or environment variable that supplies a root.
 */
export function resolveTrustedMainRoot(opts: {
  cwd: string;
  anchorDir: string;
  git?: GitSync;
}): TrustedRootResult {
  const anchorMain = verifiedMainRoot(opts.anchorDir, opts.git);
  if (!anchorMain) {
    return {
      root: null,
      reason: 'could not verify the main checkout of the repo containing this CLI',
    };
  }
  const cwdMain = verifiedMainRoot(opts.cwd, opts.git);
  if (!cwdMain || safeReal(cwdMain) !== safeReal(anchorMain)) {
    return {
      root: null,
      reason:
        'the working directory does not belong to the same verified main checkout as this CLI',
    };
  }
  return { root: anchorMain, reason: '' };
}

/**
 * Resolve the `main` BRANCH to one commit SHA (`git/ref/heads/main`, which
 * cannot be shadowed by a tag named `main` the way the short ref `main` can).
 * Every policy, config and task-tree read then uses that SHA, so they all come
 * from one consistent commit. `null` on any error or a non-commit object.
 */
export async function resolveMainSha(
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<string | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/git/ref/heads/main`,
      '--jq',
      '{type: .object.type, sha: .object.sha}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const p = JSON.parse(out.stdout) as { type?: unknown; sha?: unknown };
    return p.type === 'commit' && typeof p.sha === 'string' && /^[0-9a-f]{40}$/i.test(p.sha)
      ? p.sha
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a file from the repository's `main` branch as GitHub serves it
 * (`gh api repos/<slug>/contents/<path>?ref=<commit sha>`, raw media type). This is the
 * AUTHORITATIVE source for the policy and config: it does not depend on any
 * local ref, working tree or git environment. A gh failure, a non-200 answer,
 * or an empty body returns `null` (callers refuse).
 */
export async function readFileFromMain(
  repoSlug: string,
  ref: string,
  path: string,
  runner: Runner,
  cwd?: string,
): Promise<string | null> {
  const out = await runner(
    'gh',
    [
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repoSlug}/contents/${path}?ref=${ref}`,
    ],
    { cwd, allowFailure: true },
  );
  return out.code === 0 && out.stdout.trim() !== '' ? out.stdout : null;
}

/** Backlog task id prefix from `backlog/config.yml` `task_prefix` on main; default `AISDLC`. */
export async function readTaskPrefix(
  repoSlug: string,
  ref: string,
  runner: Runner,
  cwd?: string,
): Promise<string> {
  const text = await readFileFromMain(repoSlug, ref, 'backlog/config.yml', runner, cwd);
  const m = text ? /^task_prefix:\s*['"]?([A-Za-z][A-Za-z0-9]*)['"]?\s*$/m.exec(text) : null;
  return m?.[1] ?? 'AISDLC';
}

// ── Native governance resolution (mirrors ai-sdlc-plugin/hooks/lib/governance-resolver.js) ──

const LIST_KEYS = new Set([
  'operational',
  'protectedBranches',
  'mergeAuthors',
  // AISDLC-702: release source kind (see release-merge.ts)
  'releaseMergeRoles',
  'releaseAuthors',
]);
const BOOLEAN_KEYS = [
  'allowForcePush',
  'allowClosePrIssue',
  'allowBranchDelete',
  'allowResetHard',
] as const;
const LOGIN_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** Extract the raw `governance:` block (scalars and the known list keys); null when absent. */
export function parseGovernanceBlock(yamlText: string): Record<string, unknown> | null {
  let govIndent: number | null = null;
  const raw: Record<string, unknown> = {};
  let found = false;
  let listKey: string | null = null;

  for (const line of yamlText.split('\n')) {
    if (govIndent === null) {
      const m = /^(\s*)governance:\s*$/.exec(line);
      if (m) {
        govIndent = m[1].length;
        found = true;
      }
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const indent = /^(\s*)/.exec(line)![1].length;
    if (indent <= govIndent) break;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey) {
        const v = item[1]
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^['"]/, '')
          .replace(/['"]$/, '');
        (raw[listKey] as string[]).push(v);
      }
      continue;
    }
    listKey = null;

    const kv = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].replace(/\s+#.*$/, '').trim();
    if (value === '') {
      if (LIST_KEYS.has(key)) {
        raw[key] = [];
        listKey = key;
      }
      continue;
    }
    if (LIST_KEYS.has(key)) {
      const inline = /^\[(.*)\]$/.exec(value);
      raw[key] = inline
        ? inline[1]
            .split(',')
            .map((x) => x.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
            .filter((x) => x !== '')
        : [value];
      continue;
    }
    value = value.replace(/^['"]/, '').replace(/['"]$/, '');
    raw[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return found ? raw : null;
}

/**
 * Resolve the merge-relevant governance policy and the `mergeAuthors`
 * allow-list from committed `agent-role.yaml` text. Unknown/malformed values
 * fall back to the strict defaults; malformed logins are dropped; absent or
 * empty `mergeAuthors` trusts nobody.
 */
export function resolveGovernanceFromYaml(yamlText: string): {
  policy: GovernancePolicy;
  mergeAuthors: string[];
} {
  const policy: GovernancePolicy = { ...STRICT_DEFAULTS };
  const raw = parseGovernanceBlock(yamlText);
  if (!raw) return { policy, mergeAuthors: [] };

  if (raw['preset'] === 'operator-trusted') policy.allowMerge = 'onGreenClean';
  if (raw['allowMerge'] === 'never' || raw['allowMerge'] === 'onGreenClean') {
    policy.allowMerge = raw['allowMerge'];
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') policy[key] = raw[key] as boolean;
  }
  if (raw['allowForcePush'] === 'leaseOnOwnBranch') policy.allowForcePush = true;
  else if (raw['allowForcePush'] === 'never') policy.allowForcePush = false;

  const mergeAuthors: string[] = [];
  const list = raw['mergeAuthors'];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (
        typeof entry === 'string' &&
        entry.length <= 39 &&
        LOGIN_RE.test(entry) &&
        !mergeAuthors.some((x) => x.toLowerCase() === entry.toLowerCase())
      ) {
        mergeAuthors.push(entry);
      }
    }
  }
  return { policy, mergeAuthors };
}

// ── Work-item trust boundary (OQ-2) ─────────────────────────────────────

/**
 * `sourceKind` values threaded through the pipeline since AISDLC-393
 * (`'backlog' | 'gh-issue'`). Only `'backlog'` (internal, dispatched by our
 * own orchestrator) is trusted for agent-initiated merge. `'gh-issue'`
 * (external GitHub issue / contributor-authored work) and any unrecognised
 * value are untrusted — fail closed.
 */
export type SourceKind = 'backlog' | 'gh-issue' | 'release';

export function isTrustedSourceKind(sourceKind: SourceKind | undefined): boolean {
  return sourceKind === 'backlog';
}

// ── PR-derived trust facts (read from GitHub, not from caller flags) ────

/** One atomic `gh pr view` read of everything the trust + head-pin logic needs. */
export interface PrSnapshot {
  /** Head commit the rest of the evaluation is pinned to. */
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  authorLogin: string;
  title: string;
  mergeStateStatus: string;
  files: Array<{ path: string; changeType?: string }>;
}

const PR_VIEW_FIELDS =
  'headRefOid,headRefName,baseRefName,isCrossRepository,author,title,mergeStateStatus,files';

/**
 * Read the PR in ONE `gh pr view --json` call (head commit, merge state,
 * provenance and file list come from the same API response). Returns `null`
 * on any failure or malformed/incomplete field — callers refuse.
 */
export async function fetchPrSnapshot(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<PrSnapshot | null> {
  const out = await runner(
    'gh',
    ['pr', 'view', String(prNumber), '--json', PR_VIEW_FIELDS, '--repo', repoSlug],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const p = JSON.parse(out.stdout) as Record<string, unknown>;
    const author = p['author'] as { login?: unknown } | null | undefined;
    const files = Array.isArray(p['files']) ? (p['files'] as Array<Record<string, unknown>>) : [];
    if (
      typeof p['headRefOid'] !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(p['headRefOid']) ||
      typeof p['headRefName'] !== 'string' ||
      typeof p['baseRefName'] !== 'string' ||
      typeof p['isCrossRepository'] !== 'boolean' ||
      typeof author?.login !== 'string' ||
      typeof p['title'] !== 'string' ||
      typeof p['mergeStateStatus'] !== 'string'
    ) {
      return null;
    }
    return {
      headRefOid: p['headRefOid'],
      headRefName: p['headRefName'],
      baseRefName: p['baseRefName'],
      isCrossRepository: p['isCrossRepository'],
      authorLogin: author.login,
      title: p['title'],
      mergeStateStatus: p['mergeStateStatus'],
      files: files
        .filter((f) => typeof f['path'] === 'string')
        .map((f) => ({
          path: f['path'] as string,
          changeType: typeof f['changeType'] === 'string' ? f['changeType'] : undefined,
        })),
    };
  } catch {
    return null;
  }
}

export interface ChangedFile {
  path: string;
  /** Present for renames: the path the file had before. */
  previousPath?: string;
  status: string;
}

/** GitHub's compare endpoint reports at most 300 files; reaching it means "cannot be sure". */
const COMPARE_FILES_CAP = 300;

/**
 * Every file changed between `baseSha` and `headSha` (the merge base is used
 * automatically), read from the compare endpoint so the list is tied to the
 * PINNED head commit, not to whatever the PR head is at the moment of the call.
 * Previous names of renamed files are kept. All pages are read and deduplicated
 * (the endpoint repeats the file list on every commit page). `null` on any
 * failure, malformed output, or when the list reaches the 300-file cap.
 */
export async function fetchChangedFiles(
  baseSha: string,
  headSha: string,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<ChangedFile[] | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/compare/${baseSha}...${headSha}?per_page=100`,
      '--paginate',
      '--jq',
      '.files[]? | {filename, previous_filename, status}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const seen = new Map<string, ChangedFile>();
    for (const f of parseNdjson<{
      filename: unknown;
      previous_filename?: unknown;
      status?: unknown;
    }>(out.stdout)) {
      if (typeof f.filename !== 'string') throw new Error('shape');
      const previousPath =
        typeof f.previous_filename === 'string' ? f.previous_filename : undefined;
      seen.set(`${f.filename}\u0000${previousPath ?? ''}`, {
        path: f.filename,
        previousPath,
        status: typeof f.status === 'string' ? f.status : '',
      });
    }
    return seen.size >= COMPARE_FILES_CAP ? null : [...seen.values()];
  } catch {
    return null;
  }
}

/** Generated attestation evidence that every attested code PR commits under `.ai-sdlc/`. */
const EVIDENCE_PATH =
  /^\.ai-sdlc\/(?:(?:attestations|transcript-leaves|reviews|verdicts|transcripts)\/[^/]+|transcript-leaves\.jsonl)$/;

/** Lower-case, unify separators and resolve `.` / `..` / empty segments. */
function normalizePath(rawPath: string): string {
  const out: string[] = [];
  for (const seg of rawPath.toLowerCase().replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Paths whose change needs a human merge: the governance policy and its
 * enforcement (hooks, the merge gate itself, the policy schema), the plugin's
 * agents/commands/scripts, CI, git hooks and ownership files, and agent-harness
 * configuration. Under `.ai-sdlc/` only the generated attestation evidence files
 * (directly inside their directories) are exempt; everything else there is
 * sensitive. Compared lower-cased on the normalised path, `..` resolved.
 */
export function isGovernanceSensitivePath(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  if (EVIDENCE_PATH.test(path)) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const prefixes = [
    '.ai-sdlc/',
    '.claude/',
    '.opencode/',
    '.codex/',
    '.github/',
    '.husky/',
    'ai-sdlc-plugin/hooks/',
    'ai-sdlc-plugin/.claude-plugin/',
    'ai-sdlc-plugin/agents/',
    'ai-sdlc-plugin/commands/',
    'ai-sdlc-plugin/scripts/',
    'pipeline-cli/src/governance/',
    'pipeline-cli/src/cli/merge-if-eligible',
  ];
  const exact = [
    '.ai-sdlc',
    '.claude',
    '.opencode',
    '.codex',
    '.github',
    '.husky',
    'pipeline-cli/bin/cli-merge-if-eligible.mjs',
    'pipeline-cli/src/runtime/exec.ts',
    'pipeline-cli/package.json',
    'spec/schemas/agent-role.schema.json',
  ];
  return (
    prefixes.some((x) => path.startsWith(x)) ||
    exact.includes(path) ||
    /^scripts\/check-[^/]*$/.test(path) ||
    /^pipeline-cli\/tsconfig[^/]*\.json$/.test(path) ||
    base === 'codeowners' ||
    base === 'opencode.json' ||
    base === 'opencode.jsonc' ||
    base === 'claude.md' ||
    base === 'agents.md'
  );
}

/** The sensitive paths a PR touches (new or previous name); empty when none. */
export function governanceSensitiveChanges(files: ChangedFile[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const candidate of [f.path, f.previousPath]) {
      if (candidate && isGovernanceSensitivePath(candidate) && !hits.includes(candidate)) {
        hits.push(candidate);
      }
    }
  }
  return hits;
}

/**
 * Derive the backlog task id for a PR from its head branch (`ai-sdlc/<ID>-...`,
 * the repo's branch convention) and/or its title (trailing `(<ID>)`). The id
 * must have the repo's backlog shape: `<prefix>-<number>[.<number>...]` with the
 * prefix from `backlog/config.yml` (`task_prefix`, default `AISDLC`), so
 * `issue-N` / `gh-issue-N` style ids never qualify. When both branch and title
 * yield an id they must agree. Neither → `null`.
 */
export function deriveTaskId(
  headRefName: string,
  title: string,
  prefix = 'AISDLC',
): { taskId: string | null; conflict?: string } {
  const body = `${escapeRegExp(prefix)}-\\d+(?:\\.\\d+)*`;
  const fromBranch = new RegExp(`^ai-sdlc/(${body})(?:-|$)`, 'i').exec(headRefName)?.[1];
  const fromTitle = new RegExp(`\\((${body})\\)\\s*$`, 'i').exec(title.trim())?.[1];
  if (fromBranch && fromTitle && fromBranch.toLowerCase() !== fromTitle.toLowerCase()) {
    return {
      taskId: null,
      conflict: `head branch names task "${fromBranch}" but the title names "${fromTitle}"`,
    };
  }
  return { taskId: (fromBranch ?? fromTitle ?? null)?.toLowerCase() ?? null };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `path` is `backlog/{tasks,completed}/<id> - <slug>.md` (case-insensitive id). */
export function isBacklogTaskFileFor(taskId: string, path: string): boolean {
  return new RegExp(`^backlog/(?:tasks|completed)/${escapeRegExp(taskId)} - [^/]+\\.md$`, 'i').test(
    path,
  );
}

interface TreeListing {
  truncated: boolean;
  entries: Array<{ path: string; type: string; sha: string }>;
}

/** One non-recursive tree listing from the git trees API; `null` on any failure. */
async function fetchTree(
  repoSlug: string,
  treeish: string,
  runner: Runner,
  cwd?: string,
): Promise<TreeListing | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/git/trees/${treeish}`,
      '--jq',
      '{truncated: .truncated, tree: [.tree[] | {path, type, sha}]}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const p = JSON.parse(out.stdout) as {
      truncated?: unknown;
      tree?: Array<{ path: string; type: string; sha: string }>;
    };
    if (!Array.isArray(p.tree)) return null;
    return { truncated: p.truncated === true, entries: p.tree };
  } catch {
    return null;
  }
}

/**
 * Does a matching task file exist on the repository's `main` (per GitHub)?
 * Walks `main` -> `backlog` -> `tasks` / `completed` with non-recursive tree
 * listings, so no listing is anywhere near GitHub's truncation limit; any
 * failure or a truncated listing returns false (fail closed).
 */
export async function taskFileOnMain(
  taskId: string,
  repoSlug: string,
  ref: string,
  runner: Runner,
  cwd?: string,
): Promise<boolean> {
  const root = await fetchTree(repoSlug, ref, runner, cwd);
  if (!root || root.truncated) return false;
  const backlog = root.entries.find((e) => e.path === 'backlog' && e.type === 'tree');
  if (!backlog) return false;
  const backlogTree = await fetchTree(repoSlug, backlog.sha, runner, cwd);
  if (!backlogTree || backlogTree.truncated) return false;
  for (const dir of ['tasks', 'completed']) {
    const entry = backlogTree.entries.find((e) => e.path === dir && e.type === 'tree');
    if (!entry) continue;
    const listing = await fetchTree(repoSlug, entry.sha, runner, cwd);
    if (!listing || listing.truncated) return false;
    if (listing.entries.some((e) => isBacklogTaskFileFor(taskId, `backlog/${dir}/${e.path}`))) {
      return true;
    }
  }
  return false;
}

/**
 * Author and committer logins of a commit, read from the REST commits API for
 * that exact SHA. A login is `null` when GitHub cannot link the commit email to
 * an account. These are commit METADATA (set by whoever made the commit), not
 * authentication: they narrow who can look like an allow-listed author, but
 * the author allow-list on the PR plus GitHub-side protections are the real
 * signals.
 */
export async function fetchCommitLogins(
  sha: string,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<{ author: string | null; committer: string | null } | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${sha}`,
      '--jq',
      '{author: .author.login, committer: .committer.login}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const p = JSON.parse(out.stdout) as { author?: unknown; committer?: unknown };
    return {
      author: typeof p.author === 'string' ? p.author : null,
      committer: typeof p.committer === 'string' ? p.committer : null,
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate the GitHub-derived trust facts. Returns a refusal reason, or `null`
 * when every fact holds:
 *   - same-repo PR (`isCrossRepository === false`) — fork PRs refused;
 *   - base branch is exactly `main`;
 *   - PR author login is on the (non-empty) `mergeAuthors` allow-list;
 *   - a backlog task with the repo's id shape, derived from the branch/title,
 *     exists on `main` (per GitHub) OR is added by the PR's own diff. A PR that adds
 *     its own task file is accepted because the repo creates and completes a
 *     task in one PR; that makes the task a provenance hint, NOT a trust
 *     signal. The author allow-list is the real signal;
 *   - the head commit's author login (resolved by GitHub) is on the allow-list;
 *     an unlinked/unknown author refuses.
 * Note: `files` from `gh pr view --json` is capped by GitHub (about 100
 * entries). A task file beyond the cap is missed in the PR diff, which can only
 * turn into a refusal (the check on main then decides).
 */
export async function evaluatePrTrust(args: {
  snapshot: PrSnapshot;
  mergeAuthors: string[];
  repoSlug: string;
  taskPrefix: string;
  /** Resolves the single main commit SHA all reads use (memoised by the caller). */
  mainSha: () => Promise<string | null>;
  runner: Runner;
  cwd?: string;
}): Promise<string | null> {
  const { snapshot: pr, mergeAuthors } = args;
  if (pr.isCrossRepository !== false) {
    return 'PR is from a fork (isCrossRepository is not false) — fork PRs are never agent-merged';
  }
  if (pr.baseRefName !== 'main') {
    return `PR base branch is "${pr.baseRefName}" — agent merge is limited to base "main"`;
  }
  if (mergeAuthors.length === 0) {
    return (
      'no spec.governance.mergeAuthors allow-list is configured in .ai-sdlc/agent-role.yaml on ' +
      'main — refusing (fail-closed; an empty list trusts nobody)'
    );
  }
  const allowed = (login: string) =>
    mergeAuthors.some((a) => a.toLowerCase() === login.toLowerCase());
  if (!allowed(pr.authorLogin)) {
    return `PR author "${pr.authorLogin}" is not on the spec.governance.mergeAuthors allow-list`;
  }
  const derived = deriveTaskId(pr.headRefName, pr.title, args.taskPrefix);
  if (derived.conflict) return `ambiguous task id: ${derived.conflict}`;
  if (!derived.taskId) {
    return (
      `no backlog task id (${args.taskPrefix}-<n>[.<n>]) could be derived from head branch ` +
      `"${pr.headRefName}" (expected ai-sdlc/<id>-...) or the PR title (trailing "(<ID>)")`
    );
  }
  const inPr = pr.files.some(
    (f) =>
      f.changeType?.toUpperCase() !== 'DELETED' && isBacklogTaskFileFor(derived.taskId!, f.path),
  );
  let onMain = false;
  if (!inPr) {
    const sha = await args.mainSha();
    if (!sha)
      return 'could not resolve the main branch to a commit on GitHub — refusing (fail-closed)';
    onMain = await taskFileOnMain(derived.taskId, args.repoSlug, sha, args.runner, args.cwd);
  }
  if (!inPr && !onMain) {
    return (
      `no backlog task file for "${derived.taskId}" exists on main (per GitHub) or in this PR's own ` +
      'diff (backlog/tasks or backlog/completed)'
    );
  }
  const logins = await fetchCommitLogins(pr.headRefOid, args.repoSlug, args.runner, args.cwd);
  if (!logins) return 'could not read the head commit author from GitHub — refusing (fail-closed)';
  if (!logins.author) {
    return 'the head commit author is not linked to a GitHub account — refusing (cannot be determined)';
  }
  if (!allowed(logins.author)) {
    return `the head commit author "${logins.author}" is not on the spec.governance.mergeAuthors allow-list`;
  }
  return null;
}

// ── Required-checks + mergeStateStatus evaluation ───────────────────────

export interface RequiredCheckStatus {
  name: string;
  /** Raw state/conclusion string from `gh pr checks [--required]`. */
  state: string;
}

/**
 * Where `requiredChecks` came from (AISDLC-607 Defect 2):
 *
 *  - `'required-contexts'` — branch-protection required contexts, via
 *    `gh pr checks --required`. Historical/default behavior; byte-identical
 *    evaluation semantics preserved (AC-6).
 *  - `'check-run-fallback'` — the repo's branch protection exposes NO
 *    required contexts (common on plans without branch-protection, or repos
 *    that haven't configured any), so we fall back to the PR's actual
 *    check-runs (`gh pr checks`, unfiltered). Eligible iff every non-skipped
 *    check is SUCCESS/NEUTRAL and none are PENDING.
 */
export type ChecksSource = 'required-contexts' | 'check-run-fallback';

export interface MergeEligibilityContext {
  policy: GovernancePolicy;
  sourceKind: SourceKind | undefined;
  mergeStateStatus: string;
  /** The checks set that gates eligibility — see `checksSource` for its provenance. */
  requiredChecks: RequiredCheckStatus[];
  /** Provenance of `requiredChecks` — see `ChecksSource`. Defaults to
   *  `'required-contexts'` when omitted, preserving pre-AISDLC-607 callers'
   *  byte-identical behavior. */
  checksSource?: ChecksSource;
  /**
   * True when fetching the check-gate data itself failed/errored (non-zero
   * `gh` exit, malformed JSON) — as opposed to a successful fetch that
   * legitimately returned zero required contexts. MUST fail closed
   * regardless of `checksSource` or `requiredChecks` contents — an errored
   * fetch is NEVER treated as vacuously green (AC-5). Defaults to `false`.
   */
  checksFetchFailed?: boolean;
  /**
   * AISDLC-702: set ONLY by `release-merge.ts` after it has verified, from
   * GitHub, that the PR is a genuine release-please PR. `sourceKind: 'release'`
   * is trusted only together with this flag; on its own it is refused.
   */
  releaseVerified?: boolean;
}

export interface MergeEligibilityResult {
  eligible: boolean;
  /** Always populated — success rationale or refusal reason (auditable). */
  reason: string;
}

function isGreenState(state: string): boolean {
  return state.trim().toUpperCase() === 'SUCCESS';
}

/** Fallback-path green check: SUCCESS or NEUTRAL (case-insensitive). */
function isGreenOrNeutralState(state: string): boolean {
  const s = state.trim().toUpperCase();
  return s === 'SUCCESS' || s === 'NEUTRAL';
}

function isPendingState(state: string): boolean {
  return state.trim().toUpperCase() === 'PENDING';
}

function isSkippedState(state: string): boolean {
  return state.trim().toUpperCase() === 'SKIPPED';
}

/**
 * Pure evaluator — no IO. Order matters for the emitted `reason`: policy
 * gate first (cheapest, and callers should short-circuit fetching PR data
 * entirely when `allowMerge === 'never'`), then the OQ-2 trust boundary,
 * then mergeStateStatus, then the checks-fetch-failure guard, then the
 * checks set itself (evaluated per `checksSource`).
 */
export function evaluateMergeEligibility(ctx: MergeEligibilityContext): MergeEligibilityResult {
  const releaseTrusted = ctx.sourceKind === 'release' && ctx.releaseVerified === true;
  if (ctx.policy.allowMerge !== 'onGreenClean') {
    return {
      eligible: false,
      reason:
        `governance policy allowMerge="${ctx.policy.allowMerge}" — refusing all agent-initiated ` +
        'merges (strict default requires a human to click merge; set governance.allowMerge: ' +
        'onGreenClean in .ai-sdlc/agent-role.yaml to opt in)',
    };
  }

  if (!releaseTrusted && !isTrustedSourceKind(ctx.sourceKind)) {
    return {
      eligible: false,
      reason:
        `sourceKind="${ctx.sourceKind ?? '(unset)'}" is not trusted for agent-initiated merge — ` +
        'external/gh-issue-sourced work is NEVER merged by the agent regardless of CI state ' +
        '(RFC-0048 OQ-2 trust boundary)',
    };
  }

  if (ctx.mergeStateStatus !== 'CLEAN') {
    return {
      eligible: false,
      reason: `mergeStateStatus="${ctx.mergeStateStatus}" — required "CLEAN"`,
    };
  }

  const checksSource: ChecksSource = ctx.checksSource ?? 'required-contexts';

  // AC-5 — a genuinely FAILED/errored fetch is never vacuously green,
  // regardless of source. Checked before inspecting `requiredChecks` at all,
  // so an errored fetch that happens to have produced an empty array still
  // gets this more-specific reason rather than the generic empty-gate one.
  if (ctx.checksFetchFailed) {
    return {
      eligible: false,
      reason:
        `the ${checksSource === 'check-run-fallback' ? 'check-run' : 'required-checks'} fetch ` +
        'itself failed/errored (non-zero gh exit or unparseable output) — refusing (fail-closed; ' +
        'never treated as vacuously green)',
    };
  }

  if (checksSource === 'required-contexts') {
    if (ctx.requiredChecks.length === 0) {
      return {
        eligible: false,
        reason:
          'no required checks were resolved for this PR — refusing to merge against an empty ' +
          'gate (fail-closed; this usually means the required-checks fetch failed or branch ' +
          'protection has no required contexts configured)',
      };
    }

    const notGreen = ctx.requiredChecks.filter((c) => !isGreenState(c.state));
    if (notGreen.length > 0) {
      return {
        eligible: false,
        reason: `required check(s) not green: ${notGreen.map((c) => `${c.name}=${c.state}`).join(', ')}`,
      };
    }

    return {
      eligible: true,
      reason:
        `all ${ctx.requiredChecks.length} required check(s) green, mergeStateStatus=CLEAN, ` +
        `sourceKind=${ctx.sourceKind} (trusted) — eligible for agent-initiated merge`,
    };
  }

  // checksSource === 'check-run-fallback' (AISDLC-607 Defect 2) — branch
  // protection exposes no required contexts; fall back to the PR's real
  // check-runs. Eligible iff every non-skipped check is SUCCESS/NEUTRAL and
  // none are PENDING. An empty (post-skip-filter) set still fails closed —
  // "no checks at all" is never treated as green.
  const relevant = ctx.requiredChecks.filter((c) => !isSkippedState(c.state));
  if (relevant.length === 0) {
    return {
      eligible: false,
      reason:
        'no branch-protection required contexts AND no (non-skipped) check-runs were found on ' +
        'this PR — refusing to merge against an empty gate (fail-closed)',
    };
  }

  const pending = relevant.filter((c) => isPendingState(c.state));
  if (pending.length > 0) {
    return {
      eligible: false,
      reason:
        'no branch-protection required contexts; falling back to check-runs, but ' +
        `pending: ${pending.map((c) => `${c.name}=${c.state}`).join(', ')}`,
    };
  }

  const notGreen = relevant.filter((c) => !isGreenOrNeutralState(c.state));
  if (notGreen.length > 0) {
    return {
      eligible: false,
      reason:
        'no branch-protection required contexts; falling back to check-runs, but not green: ' +
        notGreen.map((c) => `${c.name}=${c.state}`).join(', '),
    };
  }

  return {
    eligible: true,
    reason:
      `no branch-protection required contexts configured; all ${relevant.length} check-run(s) ` +
      `SUCCESS/NEUTRAL (none pending), mergeStateStatus=CLEAN, sourceKind=${ctx.sourceKind} (trusted) — ` +
      'eligible for agent-initiated merge (check-run fallback, AISDLC-607)',
  };
}

// ── GitHub data plumbing (injectable Runner) ────────────────────────────

/**
 * Result of a checks fetch (AISDLC-607 Defect 2). `fetchFailed: true` means
 * the fetch ITSELF errored (non-zero `gh` exit, unparseable JSON) — distinct
 * from a successful fetch that legitimately returned zero checks (e.g. no
 * branch-protection required contexts configured). Evaluator callers MUST
 * fail closed on `fetchFailed`, never on a merely-empty `checks` array from a
 * successful fetch (that empty-but-successful case is what triggers the
 * check-run fallback for `required-contexts`, or the empty-gate refusal for
 * `check-run-fallback` itself).
 */
export interface ChecksFetchResult {
  checks: RequiredCheckStatus[];
  fetchFailed: boolean;
}

/**
 * Matches `gh pr checks --required`'s stderr when a repo has NO required
 * contexts configured at all (e.g. no branch protection — private/free-plan
 * repos, or a public repo that simply never set one up). Confirmed observed
 * text (AISDLC-620): `no required checks reported on the '<branch>' branch`.
 * This is a SECONDARY heuristic — a human-readable `gh` message, not a
 * structured signal — so it is intentionally permissive (case-insensitive,
 * substring) and is only ever used to WIDEN the fallback path, never to
 * narrow the fail-closed path. A genuine error (auth/network/unparseable
 * JSON) that happens not to match this pattern still fails closed below.
 */
const NO_REQUIRED_CHECKS_SENTINEL = /no required checks reported/i;

/**
 * Fetch the repo's REAL required-checks set for `prNumber` via
 * `gh pr checks --required`, which GitHub CLI resolves from actual branch
 * protection / the `ai-sdlc/pr-ready` rollup — never a hardcoded subset, so
 * opting into agent-merge removes only the "human clicks merge" step, never
 * a safety gate. `checks: []` + `fetchFailed: false` means the fetch
 * SUCCEEDED with zero required contexts configured (e.g. no branch
 * protection) — the caller falls back to `fetchAllCheckRuns`. `fetchFailed:
 * true` means the fetch itself errored — the caller MUST fail closed rather
 * than falling back (AC-5).
 *
 * AISDLC-620: on a repo with NO branch protection at all, `gh pr checks
 * --required` does not exit 0 with an empty array (the AISDLC-607 case) —
 * it exits **1** with stderr `no required checks reported on the '<branch>'
 * branch`. Without this check, that exit-1 was indistinguishable from a
 * genuine fetch error, so `fetchFailed:true` was returned and the AISDLC-607
 * check-run fallback was never reached, permanently refusing eligibility on
 * exactly the topology the fallback was built for. Any OTHER non-zero exit
 * (auth failure, network error, unparseable JSON) still returns
 * `fetchFailed: true`, preserving the fail-closed guarantee.
 */
export async function fetchRequiredChecks(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<ChecksFetchResult> {
  const out = await runner(
    'gh',
    ['pr', 'checks', String(prNumber), '--required', '--json', 'name,state', '--repo', repoSlug],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) {
    if (NO_REQUIRED_CHECKS_SENTINEL.test(out.stderr)) {
      // Successful-but-empty: no required contexts configured at all. The
      // caller falls through to `fetchAllCheckRuns` exactly as it does for
      // the exit-0 + `[]` shape.
      return { checks: [], fetchFailed: false };
    }
    return { checks: [], fetchFailed: true };
  }
  try {
    const parsed = JSON.parse(out.stdout) as Array<{ name: string; state: string }>;
    return { checks: parsed.map((p) => ({ name: p.name, state: p.state })), fetchFailed: false };
  } catch {
    return { checks: [], fetchFailed: true };
  }
}

/** Parse newline-delimited JSON objects (one per `gh api --paginate --jq` element). */
function parseNdjson<T>(text: string): T[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as T);
}

/**
 * Check runs and commit statuses for the EXACT commit `sha` (not "the PR's
 * current head"), so the evaluation is bound to the head that will be merged.
 * All pages are read (`gh api --paginate`). Check runs: `status != completed`
 * is PENDING, otherwise the upper-cased conclusion. Statuses: the upper-cased
 * state. `fetchFailed` on any gh error or unparseable output.
 */
export async function fetchShaChecks(
  sha: string,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<ChecksFetchResult> {
  const runsOut = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${sha}/check-runs?per_page=100`,
      '--paginate',
      '--jq',
      '.check_runs[] | {name, status, conclusion}',
    ],
    { cwd, allowFailure: true },
  );
  const statusOut = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${sha}/status?per_page=100`,
      '--paginate',
      '--jq',
      '.statuses[] | {context, state}',
    ],
    { cwd, allowFailure: true },
  );
  if (runsOut.code !== 0 || statusOut.code !== 0) return { checks: [], fetchFailed: true };
  try {
    const runs = parseNdjson<{ name: string; status: string; conclusion: string | null }>(
      runsOut.stdout,
    );
    const statuses = parseNdjson<{ context: string; state: string }>(statusOut.stdout);
    if (
      runs.some((c) => typeof c.name !== 'string' || typeof c.status !== 'string') ||
      statuses.some((c) => typeof c.context !== 'string' || typeof c.state !== 'string')
    ) {
      return { checks: [], fetchFailed: true };
    }
    const checks: RequiredCheckStatus[] = [
      ...runs.map((c) => ({
        name: c.name,
        state: c.status !== 'completed' ? 'PENDING' : (c.conclusion ?? 'UNKNOWN').toUpperCase(),
      })),
      ...statuses.map((c) => ({ name: c.context, state: c.state.toUpperCase() })),
    ];
    return { checks, fetchFailed: false };
  } catch {
    return { checks: [], fetchFailed: true };
  }
}

/** State of the required check `name` among the head commit's results (MISSING when absent). */
export function stateForRequired(name: string, results: RequiredCheckStatus[]): string {
  const matches = results.filter((c) => c.name === name);
  if (matches.length === 0) return 'MISSING';
  return matches.find((c) => c.state.toUpperCase() !== 'SUCCESS')?.state ?? 'SUCCESS';
}

export interface MergePrResult {
  ok: boolean;
  /** gh stderr (trimmed) when the merge was refused/failed. */
  error: string;
}

/**
 * The raw merge call: the ONLY mutation this module performs, and only when
 * eligible. Always pinned with `--match-head-commit <sha>`: GitHub itself
 * refuses the merge when the PR head is no longer `<sha>`, so a head that
 * moved after the checks were evaluated cannot be merged. A refusal is
 * returned (not thrown) so the caller can report it and exit non-zero.
 */
export async function mergePr(
  prNumber: number,
  repoSlug: string,
  mergeMethod: 'squash' | 'merge' | 'rebase',
  headSha: string,
  runner: Runner,
  cwd?: string,
): Promise<MergePrResult> {
  const out = await runner(
    'gh',
    [
      'pr',
      'merge',
      String(prNumber),
      `--${mergeMethod}`,
      '--match-head-commit',
      headSha,
      '--repo',
      repoSlug,
    ],
    { cwd, allowFailure: true },
  );
  return { ok: out.code === 0, error: out.stderr.trim() };
}

/**
 * Arm auto-merge (the repository workflow arms with `--auto --squash`, so the
 * default method here matches). Pinned with `--match-head-commit <sha>`; the
 * caller also re-reads the head just before, so a head that moved is refused
 * even if gh does not enforce the pin for arming. Refusals are returned, not thrown.
 */
export async function armPr(
  prNumber: number,
  repoSlug: string,
  mergeMethod: 'squash' | 'merge' | 'rebase',
  headSha: string,
  runner: Runner,
  cwd?: string,
): Promise<MergePrResult> {
  const out = await runner(
    'gh',
    [
      'pr',
      'merge',
      String(prNumber),
      '--auto',
      `--${mergeMethod}`,
      '--match-head-commit',
      headSha,
      '--repo',
      repoSlug,
    ],
    { cwd, allowFailure: true },
  );
  return { ok: out.code === 0, error: out.stderr.trim() };
}

/** `owner/repo` of the checkout at `cwd` via `gh repo view`; `null` on failure or empty output. */
export async function resolveRepoSlug(runner: Runner, cwd?: string): Promise<string | null> {
  const out = await runner(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd, allowFailure: true },
  );
  const slug = out.stdout.trim();
  const [owner, name] = slug.split('/');
  const dots = (x: string | undefined) => x === '.' || x === '..';
  return out.code === 0 && /^[\w.-]+\/[\w.-]+$/.test(slug) && !dots(owner) && !dots(name)
    ? slug
    : null;
}

// ── Top-level orchestration ──────────────────────────────────────────────

export interface RunMergeIfEligibleOptions {
  prNumber: number;
  sourceKind: SourceKind | undefined;
  repoSlug: string;
  /**
   * The VERIFIED main checkout (see `resolveTrustedMainRoot`). `null` = none
   * could be established → refuse (fail closed); `rootRefusal` carries the reason.
   */
  repoRoot: string | null;
  rootRefusal?: string;
  runner: Runner;
  cwd?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  dryRun?: boolean;
  /**
   * Programmatic injection (tests): committed `agent-role.yaml` text, or `null`
   * for "unreadable". When omitted the text is read from main via
   * the GitHub contents API.
   */
  policyYaml?: string | null;
  /** Programmatic injection (tests): backlog id prefix (default: read from main via GitHub). */
  taskPrefix?: string;
  /**
   * `merge` (default): merge once green + CLEAN. `arm`: enable auto-merge
   * (GitHub then merges once ITS required checks pass). Arming is a merge in
   * waiting, so it needs the same `onGreenClean` grant and the same trust
   * checks; it only skips the green/CLEAN evaluation, because waiting for
   * checks is the point of arming.
   */
  mode?: 'merge' | 'arm';
}

export interface RunMergeIfEligibleResult {
  prNumber: number;
  policy: GovernancePolicy;
  eligibility: MergeEligibilityResult;
  merged: boolean;
  /** True when auto-merge was armed (`mode: 'arm'`). */
  armed?: boolean;
  dryRun: boolean;
}

/** Build a refusal result (policy fails closed to strict defaults unless given). */
export function refusalResult(
  prNumber: number,
  reason: string,
  dryRun: boolean | undefined,
  policy: GovernancePolicy = STRICT_DEFAULTS,
): RunMergeIfEligibleResult {
  return {
    prNumber,
    policy: { ...policy },
    eligibility: { eligible: false, reason },
    merged: false,
    dryRun: Boolean(dryRun),
  };
}

/**
 * Compose policy resolution + PR-state fetch + evaluation + (conditionally)
 * the merge call. Order, each step failing closed:
 *   1. verified main checkout (else refuse);
 *   2. policy on main (per GitHub), `allowMerge` and caller `sourceKind`
 *      (no `gh` calls spent on a refusal);
 *   3. ONE `gh pr view` read (head commit, merge state, fork/author/base/title/files)
 *      then the trust facts (`evaluatePrTrust`);
 *   4. the required check names, then the check runs / statuses of that exact
 *      head commit (or all of them when no required contexts exist);
 *   5. eligibility evaluation;
 *   6. just before merging, re-read the PR: the head commit must still be the
 *      one the checks were evaluated against and still CLEAN, then merge with
 *      `--match-head-commit <sha>` so GitHub enforces the pin atomically.
 */
export async function runMergeIfEligible(
  opts: RunMergeIfEligibleOptions,
): Promise<RunMergeIfEligibleResult> {
  if (opts.repoRoot === null) {
    return refusalResult(
      opts.prNumber,
      'could not establish a verified main checkout to read the governance policy from' +
        (opts.rootRefusal ? ` (${opts.rootRefusal})` : '') +
        ' — refusing (fail-closed; the worktree/cwd copy is never trusted)',
      opts.dryRun,
    );
  }

  // One consistent commit: the `main` branch is resolved to a SHA once (a tag
  // named main cannot shadow it) and every read below uses that SHA.
  let mainShaPromise: Promise<string | null> | undefined;
  const mainSha = () => (mainShaPromise ??= resolveMainSha(opts.repoSlug, opts.runner, opts.cwd));

  let yamlText: string | null;
  if (opts.policyYaml !== undefined) {
    yamlText = opts.policyYaml;
  } else {
    const sha = await mainSha();
    yamlText = sha
      ? await readFileFromMain(
          opts.repoSlug,
          sha,
          '.ai-sdlc/agent-role.yaml',
          opts.runner,
          opts.cwd,
        )
      : null;
  }
  if (yamlText === null) {
    return refusalResult(
      opts.prNumber,
      'could not read .ai-sdlc/agent-role.yaml from main as GitHub serves it (local refs, ' +
        'working trees and worktree copies are never used) — refusing (fail-closed)',
      opts.dryRun,
    );
  }
  const { policy, mergeAuthors } = resolveGovernanceFromYaml(yamlText);

  // Policy gate, then the caller-supplied trust boundary: both can refuse
  // before any network call is spent.
  if (opts.sourceKind === 'release') {
    // AISDLC-702: release PRs are handled ONLY by release-merge.ts (own gate).
    // This backlog path never merges them, whatever the policy says.
    return refusalResult(
      opts.prNumber,
      'sourceKind="release" is handled by the release merge path, not this one — refusing. ' +
        'Next step: run `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm`.',
      opts.dryRun,
      policy,
    );
  }
  if (policy.allowMerge !== 'onGreenClean' || !isTrustedSourceKind(opts.sourceKind)) {
    return {
      prNumber: opts.prNumber,
      policy,
      eligibility: evaluateMergeEligibility({
        policy,
        sourceKind: opts.sourceKind,
        mergeStateStatus: 'UNKNOWN',
        requiredChecks: [],
      }),
      merged: false,
      dryRun: Boolean(opts.dryRun),
    };
  }

  const refuse = (reason: string): RunMergeIfEligibleResult =>
    refusalResult(opts.prNumber, reason, opts.dryRun, policy);

  const snapshot = await fetchPrSnapshot(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!snapshot) {
    return refuse(
      'could not read the PR (head commit, author, base, fork flag) from GitHub in one ' +
        '`gh pr view` call, or a required field was missing — refusing (fail-closed)',
    );
  }

  let taskPrefix = opts.taskPrefix;
  if (taskPrefix === undefined) {
    const sha = await mainSha();
    if (!sha) {
      return refuse(
        'could not resolve the main branch to a commit on GitHub — refusing (fail-closed)',
      );
    }
    taskPrefix = await readTaskPrefix(opts.repoSlug, sha, opts.runner, opts.cwd);
  }
  const trustRefusal = await evaluatePrTrust({
    snapshot,
    mergeAuthors,
    repoSlug: opts.repoSlug,
    taskPrefix,
    mainSha,
    runner: opts.runner,
    cwd: opts.cwd,
  });
  if (trustRefusal) return refuse(trustRefusal);

  // Governance-sensitive changes need a human merge (merge AND arm modes).
  const baseSha = await mainSha();
  const changed = baseSha
    ? await fetchChangedFiles(baseSha, snapshot.headRefOid, opts.repoSlug, opts.runner, opts.cwd)
    : null;
  if (!changed) {
    return refuse(
      'could not list every file this PR changes (GitHub error, or the list hit its 300-file cap) — ' +
        'refusing (fail-closed); a human merges what cannot be inspected',
    );
  }
  if (changed.length === 0) {
    return refuse('the PR has no changed files relative to main — nothing to merge');
  }
  const sensitive = governanceSensitiveChanges(changed);
  if (sensitive.length > 0) {
    return refuse(
      `the PR changes governance-sensitive paths (${sensitive.slice(0, 5).join(', ')}` +
        `${sensitive.length > 5 ? `, +${sensitive.length - 5} more` : ''}) — these require a human merge`,
    );
  }

  if (opts.mode === 'arm') {
    const armEligibility: MergeEligibilityResult = {
      eligible: true,
      reason:
        `policy allowMerge=onGreenClean, sourceKind=backlog, trust checks passed for head ` +
        `${snapshot.headRefOid} — eligible to arm auto-merge (GitHub merges only once its own ` +
        'required checks pass)',
    };
    if (opts.dryRun) {
      return {
        prNumber: opts.prNumber,
        policy,
        eligibility: armEligibility,
        merged: false,
        dryRun: true,
      };
    }
    const reread = await fetchPrSnapshot(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
    if (!reread) {
      return refuse('could not re-read the PR immediately before arming — refusing (fail-closed)');
    }
    if (reread.headRefOid.toLowerCase() !== snapshot.headRefOid.toLowerCase()) {
      return refuse(
        `the PR head moved from ${snapshot.headRefOid} to ${reread.headRefOid} after the trust ` +
          'checks — refusing to arm; re-run for the new head',
      );
    }
    const armResult = await armPr(
      opts.prNumber,
      opts.repoSlug,
      opts.mergeMethod ?? 'squash',
      snapshot.headRefOid,
      opts.runner,
      opts.cwd,
    );
    if (!armResult.ok) {
      return refuse(
        `arming auto-merge was refused by GitHub (head pinned to ${snapshot.headRefOid}): ` +
          (armResult.error || '(no error text)'),
      );
    }
    return {
      prNumber: opts.prNumber,
      policy,
      eligibility: armEligibility,
      merged: false,
      armed: true,
      dryRun: false,
    };
  }

  // Which contexts are REQUIRED comes from `gh pr checks --required` (names
  // only; it reports the PR's current head). Their STATE comes from the exact
  // head commit read above. No required contexts at all (successful fetch) →
  // every check run / status of that commit; a failed fetch never falls back.
  const requiredResult = await fetchRequiredChecks(
    opts.prNumber,
    opts.repoSlug,
    opts.runner,
    opts.cwd,
  );
  let requiredChecks: RequiredCheckStatus[] = [];
  let checksSource: ChecksSource = 'required-contexts';
  let checksFetchFailed = requiredResult.fetchFailed;

  if (!requiredResult.fetchFailed) {
    const shaResult = await fetchShaChecks(
      snapshot.headRefOid,
      opts.repoSlug,
      opts.runner,
      opts.cwd,
    );
    checksFetchFailed = shaResult.fetchFailed;
    if (requiredResult.checks.length > 0) {
      requiredChecks = requiredResult.checks.map((c) => ({
        name: c.name,
        state: stateForRequired(c.name, shaResult.checks),
      }));
    } else {
      checksSource = 'check-run-fallback';
      requiredChecks = shaResult.checks;
    }
  }

  const eligibility = evaluateMergeEligibility({
    policy,
    sourceKind: opts.sourceKind,
    mergeStateStatus: snapshot.mergeStateStatus,
    requiredChecks,
    checksSource,
    checksFetchFailed,
  });

  if (!eligibility.eligible || opts.dryRun) {
    return {
      prNumber: opts.prNumber,
      policy,
      eligibility,
      merged: false,
      dryRun: Boolean(opts.dryRun),
    };
  }

  // Head-pin: the checks above describe `snapshot.headRefOid`. Re-read the PR;
  // if the head moved (or the PR is no longer CLEAN) refuse, and pin the merge
  // itself to that commit so GitHub rejects a late push as well.
  const recheck = await fetchPrSnapshot(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!recheck) {
    return refuse('could not re-read the PR immediately before merging — refusing (fail-closed)');
  }
  if (recheck.headRefOid.toLowerCase() !== snapshot.headRefOid.toLowerCase()) {
    return refuse(
      `the PR head moved from ${snapshot.headRefOid} to ${recheck.headRefOid} after the checks ` +
        'were evaluated — refusing; re-run once the new head is green',
    );
  }
  if (recheck.mergeStateStatus !== 'CLEAN') {
    return refuse(`mergeStateStatus="${recheck.mergeStateStatus}" on the pre-merge re-read`);
  }

  const mergeResult = await mergePr(
    opts.prNumber,
    opts.repoSlug,
    opts.mergeMethod ?? 'squash',
    snapshot.headRefOid,
    opts.runner,
    opts.cwd,
  );
  if (!mergeResult.ok) {
    return refuse(
      `the merge was refused by GitHub (head pinned to ${snapshot.headRefOid}; a head that moved ` +
        `after the check fails closed): ${mergeResult.error || '(no error text)'}`,
    );
  }

  return { prNumber: opts.prNumber, policy, eligibility, merged: true, dryRun: false };
}
