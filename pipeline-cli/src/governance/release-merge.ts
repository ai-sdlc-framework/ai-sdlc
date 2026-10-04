/**
 * `--source-kind release` for `cli-merge-if-eligible` (AISDLC-702).
 *
 * Why this exists: the rolling release-please PR (`chore: release main`) is
 * neither `backlog` nor `gh-issue` work, and the governance hook refuses raw
 * `gh pr merge`. The operator decided (2026-10-03) that agents acting on his
 * explicit instruction may land release PRs through a sanctioned path.
 *
 * Trust model (read this before changing anything):
 *
 *  - The REAL control is the set of facts read from GitHub for the exact PR
 *    head: same-repo branch `release-please--branches--main`, base `main`,
 *    author on the release-author allow-list, every commit authored by an
 *    allowed release identity, every changed file on a fixed allowlist of
 *    release artifacts, and required checks green. Nothing the caller says
 *    about the PR is believed.
 *  - Release identity, resolved from `.github/workflows/release.yml` and past
 *    release PRs (#1078, #1105): release-please runs with the `AI_SDLC_PAT`
 *    token, so the PR and its release-please commit are authored by the
 *    operator account that owns that PAT (not a distinct bot login). The
 *    AISDLC-577 pin-sync job commits as `AI-SDLC Release Bot
 *    <release-bot@ai-sdlc.io>`, an identity with NO linked GitHub login. So
 *    the allowed authors are: the logins in `governance.releaseAuthors`
 *    (REQUIRED and non-empty; no fallback to `mergeAuthors`, so emptying it is
 *    the kill switch) and that one unlinked release-bot identity. Author AND
 *    committer are checked. The commits on #1078/#1105 are unsigned, so a
 *    verified signature cannot be required: identity is weak metadata, and the
 *    per-file content validation (only version-like values may change) is what
 *    actually bounds what a forged release PR could publish. No login is
 *    hardcoded here.
 *  - Residual risks: auto-merge armed by `--arm` persists on GitHub; a later push
 *    to the release branch is still gated by `--match-head-commit` at arm time
 *    and by branch protection afterwards, not by this CLI. The base for content
 *    comparison is the tip of main, so a main that moved a release file refuses
 *    (fail-closed) until release-please rebases.
 *  - The caller-role restriction (`governance.releaseMergeRoles`, default
 *    operator + planner, executor denied) is a MISTAKE GUARD, not a security
 *    boundary: the role comes from the caller's environment and a same-user CLI
 *    check cannot stop a determined same-user process (DEC-0038).
 *  - The release path has its own gate and does not require
 *    `governance.allowMerge: onGreenClean`; it can only ever merge a PR that
 *    passes every check above, so it widens merge rights to release PRs only.
 *
 * @module governance/release-merge
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Runner } from '../runtime/exec.js';
import {
  armPr,
  evaluateMergeEligibility,
  fetchChangedFiles,
  fetchPrSnapshot,
  fetchRequiredChecks,
  fetchShaChecks,
  mergePr,
  parseGovernanceBlock,
  readFileFromMain,
  refusalResult,
  resolveGovernanceFromYaml,
  resolveMainSha,
  stateForRequired,
  type ChangedFile,
  type ChecksSource,
  type RequiredCheckStatus,
  type RunMergeIfEligibleResult,
} from './merge-if-eligible.js';

/** The single branch release-please maintains for the rolling release PR. */
export const RELEASE_BRANCH = 'release-please--branches--main';

/** Git identity of the AISDLC-577 / AISDLC-574 pin-sync commits (release.yml). */
export const RELEASE_BOT_EMAIL = 'release-bot@ai-sdlc.io';

/** Caller roles allowed when `governance.releaseMergeRoles` is absent. */
export const DEFAULT_RELEASE_MERGE_ROLES: readonly string[] = ['operator', 'planner'];

const NODE_PACKAGE_DIRS = [
  'reference',
  'conformance/runner',
  'sdk-typescript',
  'orchestrator',
  'mcp-advisor',
  'pipeline-cli',
  'ai-sdlc-plugin/mcp-server',
];
const CHANGELOG_DIRS = [
  '',
  'reference',
  'conformance/runner',
  'sdk-typescript',
  'orchestrator',
  'mcp-advisor',
  'pipeline-cli',
  'sdk-python',
  'sdk-go',
  'ai-sdlc-plugin',
];

/**
 * Files a release-please PR may change: changelogs, the version fields of the
 * packages in release-please-config.json, the release-please manifest/config,
 * and the plugin manifests (version + the AISDLC-577 runtimeDependencies pin
 * sync, which touches exactly the two plugin.json files). Anything else makes
 * the PR ineligible.
 */
export const RELEASE_FILE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...CHANGELOG_DIRS.map((d) => (d ? `${d}/CHANGELOG.md` : 'CHANGELOG.md')),
  ...NODE_PACKAGE_DIRS.map((d) => `${d}/package.json`),
  'sdk-python/pyproject.toml',
  '.release-please-manifest.json',
  'release-please-config.json',
  '.claude-plugin/marketplace.json',
  'ai-sdlc-plugin/plugin.json',
  'ai-sdlc-plugin/.claude-plugin/plugin.json',
]);

export function isReleaseArtifactPath(path: string): boolean {
  return RELEASE_FILE_ALLOWLIST.has(path);
}

/** Changed paths (including pre-rename paths) that are not release artifacts. */
export function nonReleaseFiles(files: ChangedFile[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (!isReleaseArtifactPath(f.path)) bad.push(f.path);
    if (f.previousPath !== undefined && !isReleaseArtifactPath(f.previousPath)) {
      bad.push(f.previousPath);
    }
  }
  return bad;
}

// ── Governance: who may use `--source-kind release` ─────────────────────

export interface ReleaseGovernance {
  /** Caller roles allowed to use `--source-kind release`. */
  roles: string[];
  /** GitHub logins allowed as the release PR author and as linked commit authors. */
  authors: string[];
}

const ROLE_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const LOGIN_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * Resolve the release governance from committed `agent-role.yaml` text.
 * `releaseMergeRoles` defaults to operator + planner; `releaseAuthors` falls
 * back to `mergeAuthors`. Malformed entries are dropped; an empty author list
 * trusts nobody (fail closed).
 */
export function resolveReleaseGovernance(yamlText: string): ReleaseGovernance {
  const raw = parseGovernanceBlock(yamlText) ?? {};
  const clean = (v: unknown, re: RegExp, max: number): string[] | null => {
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const e of v) {
      if (typeof e === 'string' && e.length <= max && re.test(e)) {
        const k = e.toLowerCase();
        if (!out.some((x) => x.toLowerCase() === k)) out.push(e);
      }
    }
    return out;
  };
  const roles = clean(raw['releaseMergeRoles'], ROLE_RE, 40) ?? [...DEFAULT_RELEASE_MERGE_ROLES];
  // Kill switch: an explicit, non-empty `releaseAuthors` is REQUIRED. There is
  // deliberately no fallback to `mergeAuthors`, so removing/emptying the key on
  // main disables the whole release path.
  const authors = clean(raw['releaseAuthors'], LOGIN_RE, 39) ?? [];
  return { roles: roles.map((r) => r.toLowerCase()), authors };
}

/** True when an `.active-task` sentinel exists in `cwd` or any ancestor directory. */
export function hasActiveTaskSentinel(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.active-task'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Caller role. `AI_SDLC_CALLER_ROLE` wins when set (explicit). Otherwise a
 * session carrying an active task (`AI_SDLC_ACTIVE_TASK_ID`, or an
 * `.active-task` sentinel in the cwd or an ancestor) is a dispatched executor.
 * With neither, the role is undeterminable and `null` is returned: the caller
 * refuses rather than guessing "operator". Environment/filesystem-derived, so a
 * MISTAKE GUARD only.
 */
export function resolveCallerRole(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const explicit = env.AI_SDLC_CALLER_ROLE?.trim().toLowerCase();
  if (explicit) return explicit;
  if (env.AI_SDLC_ACTIVE_TASK_ID?.trim() || hasActiveTaskSentinel(cwd)) return 'executor';
  return null;
}

// ── PR commits ──────────────────────────────────────────────────────────

export interface PrCommit {
  sha: string;
  /** Linked GitHub login of the author, or null when the email is unlinked. */
  authorLogin: string | null;
  authorEmail: string;
  committerLogin: string | null;
  committerEmail: string;
  /** GitHub's signature verification flag (recorded in the audit only). */
  verified: boolean;
}

/** GitHub caps this endpoint at 250 commits; reaching it means "cannot be sure". */
const PR_COMMITS_CAP = 250;

export async function fetchPrCommits(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<PrCommit[] | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/pulls/${prNumber}/commits?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {sha, login: .author.login, email: .commit.author.email, clogin: .committer.login, cemail: .commit.committer.email, verified: .commit.verification.verified}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const commits = out.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const parsed: PrCommit[] = [];
    for (const c of commits) {
      if (
        typeof c.sha !== 'string' ||
        typeof c.email !== 'string' ||
        typeof c.cemail !== 'string'
      ) {
        return null;
      }
      parsed.push({
        sha: c.sha,
        authorLogin: typeof c.login === 'string' ? c.login : null,
        authorEmail: c.email,
        committerLogin: typeof c.clogin === 'string' ? c.clogin : null,
        committerEmail: c.cemail,
        verified: c.verified === true,
      });
    }
    return parsed.length === 0 || parsed.length >= PR_COMMITS_CAP ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Refusal reason for the first commit whose author OR committer is not an
 * allowed release identity, else null. Allowed: a login on `authors`, or an
 * unlinked identity with the release-bot email (the pin-sync job).
 *
 * Signature verification is NOT required: the release-please and pin-sync
 * commits on past release PRs (#1078, #1105) are unsigned (`verified: false`,
 * reason `unsigned`), so requiring it would refuse every genuine release. The
 * author/committer identity is commit METADATA anyone with push access can set,
 * so this is a weak control; the file-content validation is what bounds impact.
 */
export function commitAuthorRefusal(commits: PrCommit[], authors: string[]): string | null {
  const allowed = (l: string) => authors.some((a) => a.toLowerCase() === l.toLowerCase());
  const check = (sha: string, role: string, login: string | null, email: string): string | null => {
    if (login !== null) {
      return allowed(login)
        ? null
        : `commit ${sha.slice(0, 8)} ${role} is "${login}", not an allowed release identity`;
    }
    return email.toLowerCase() === RELEASE_BOT_EMAIL
      ? null
      : `commit ${sha.slice(0, 8)} has an unlinked ${role} "${email}", not the release bot (${RELEASE_BOT_EMAIL})`;
  };
  for (const c of commits) {
    const bad =
      check(c.sha, 'author', c.authorLogin, c.authorEmail) ??
      check(c.sha, 'committer', c.committerLogin, c.committerEmail);
    if (bad) return bad;
  }
  return null;
}

// ── File content validation ─────────────────────────────────────────────

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Pin-sync value shape (scripts/sync-plugin-runtime-deps.mjs): `>=X.Y.Z <1.0.0`. */
const PIN = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <1\.0\.0$/;

/**
 * The only JSON paths a release may change, per file, with the shape the new
 * value must have (what release-please and the AISDLC-577 pin-sync write).
 * Everything else must be byte-for-byte equal after parsing.
 */
function mutableValueRule(file: string, path: Array<string | number>): RegExp | null {
  const key = path.join('.');
  if (file === '.release-please-manifest.json') return path.length === 1 ? SEMVER : null;
  if (file === '.claude-plugin/marketplace.json')
    return key === 'plugins.0.version' ? SEMVER : null;
  if (
    file === 'ai-sdlc-plugin/plugin.json' ||
    file === 'ai-sdlc-plugin/.claude-plugin/plugin.json'
  ) {
    if (key === 'version') return SEMVER;
    if (key === 'runtimeDependencies.@ai-sdlc/orchestrator') return PIN;
    if (key === 'runtimeDependencies.@ai-sdlc/pipeline-cli') return PIN;
    return null;
  }
  if (file.endsWith('/package.json')) return key === 'version' ? SEMVER : null;
  return null; // release-please-config.json: nothing may change
}

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Paths whose values differ (or exist on one side only) between two parsed JSON documents. */
export function jsonDiffPaths(
  a: Json,
  b: Json,
  path: Array<string | number> = [],
): Array<{ path: Array<string | number>; newValue: Json }> {
  if (isObj(a) && isObj(b)) {
    const out: Array<{ path: Array<string | number>; newValue: Json }> = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a) || !(k in b))
        out.push({ path: [...path, k], newValue: Symbol.for('structural') });
      else out.push(...jsonDiffPaths(a[k], b[k], [...path, k]));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [{ path, newValue: Symbol.for('structural') }];
    return a.flatMap((v, i) => jsonDiffPaths(v, b[i], [...path, i]));
  }
  return a === b ? [] : [{ path, newValue: b }];
}

/**
 * Refusal reason when `base` -> `head` changes anything but version-like values
 * in `file`, else null. Unparsable content is a refusal.
 */
export function jsonContentRefusal(file: string, base: string, head: string): string | null {
  let a: Json;
  let b: Json;
  try {
    a = JSON.parse(base);
    b = JSON.parse(head);
  } catch {
    return `${file}: content is not parseable JSON`;
  }
  for (const d of jsonDiffPaths(a, b)) {
    const rule = mutableValueRule(file, d.path);
    if (!rule || typeof d.newValue !== 'string' || !rule.test(d.newValue)) {
      return `${file}: key "${d.path.join('.') || '(root)'}" changed and is not a version value`;
    }
  }
  return null;
}

/** pyproject.toml: only the `version = "X.Y.Z"` line may change. */
export function tomlContentRefusal(file: string, base: string, head: string): string | null {
  const re = /^version\s*=\s*"([^"\n]*)"\s*$/m;
  const hv = re.exec(head);
  if (!hv || !SEMVER.test(hv[1]) || !re.test(base)) {
    return `${file}: key "version" is missing or not a version value`;
  }
  if (base.replace(re, 'version = ""') !== head.replace(re, 'version = ""')) {
    return `${file}: content other than the "version" key changed`;
  }
  return null;
}

interface Blob {
  type: string;
  text: string;
}

/** Contents-API read of one file at one commit; null on any failure. */
async function fetchBlob(
  repoSlug: string,
  ref: string,
  path: string,
  runner: Runner,
  cwd?: string,
): Promise<Blob | null> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/contents/${path}?ref=${ref}`,
      '--jq',
      '{type: .type, content: .content}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const p = JSON.parse(out.stdout) as { type?: unknown; content?: unknown };
    if (typeof p.type !== 'string') return null;
    const text =
      typeof p.content === 'string' ? Buffer.from(p.content, 'base64').toString('utf8') : '';
    return { type: p.type, text };
  } catch {
    return null;
  }
}

/**
 * Validate every changed file: status must be added/modified for CHANGELOG.md
 * and modified only for the rest (no removed, renamed, copied); the head entry
 * must be a regular file (not a symlink or submodule); and every non-changelog
 * file must differ from its base only in version-like values. Returns a
 * refusal reason or null. Fails closed when a blob cannot be fetched.
 */
export async function validateReleaseContent(
  files: ChangedFile[],
  baseSha: string,
  headSha: string,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<string | null> {
  for (const f of files) {
    const changelog = f.path.endsWith('CHANGELOG.md');
    if (f.previousPath !== undefined || f.status === 'renamed' || f.status === 'copied') {
      return `${f.path}: file status "${f.status}" (rename/copy) is not allowed`;
    }
    if (f.status === 'removed') return `${f.path}: file removal is not allowed`;
    if (f.status !== 'modified' && !(changelog && f.status === 'added')) {
      return `${f.path}: unexpected file status "${f.status}"`;
    }
    const head = await fetchBlob(repoSlug, headSha, f.path, runner, cwd);
    if (!head) return `${f.path}: could not fetch the head content (fail-closed)`;
    if (head.type !== 'file') return `${f.path}: is a "${head.type}", not a regular file`;
    if (changelog) continue; // markdown: any content
    const base = await fetchBlob(repoSlug, baseSha, f.path, runner, cwd);
    if (!base) return `${f.path}: could not fetch the base content (fail-closed)`;
    if (base.type !== 'file') return `${f.path}: base is a "${base.type}", not a regular file`;
    const bad = f.path.endsWith('.toml')
      ? tomlContentRefusal(f.path, base.text, head.text)
      : jsonContentRefusal(f.path, base.text, head.text);
    if (bad) return bad;
  }
  return null;
}

// ── Audit log ───────────────────────────────────────────────────────────

export interface ReleaseAuditRecord {
  ts: string;
  event: 'release-merge';
  sourceKind: 'release';
  prNumber: number;
  repo: string;
  caller: string;
  callerRole: string;
  mode: 'merge' | 'arm';
  headSha?: string;
  /** gh-authenticated login (`gh api user`); null when unavailable. */
  ghLogin?: string | null;
  /** True when every PR commit carries a verified signature (informational). */
  commitsVerified?: boolean;
  outcome: 'merged' | 'armed' | 'refused' | 'dry-run';
  reason: string;
}

export type AuditWriter = (record: ReleaseAuditRecord) => void;

/**
 * Default audit sink: append-only JSONL at
 * `$ARTIFACTS_DIR/_governance/merge-audit-YYYY-MM-DD.jsonl` (the same
 * artifacts-dir convention as the orchestrator events log). Best-effort: a
 * write failure never changes the merge outcome.
 */
export function defaultAuditWriter(artifactsDir?: string): AuditWriter {
  return (record) => {
    try {
      const dir = join(
        artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts'),
        '_governance',
      );
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `merge-audit-${record.ts.slice(0, 10)}.jsonl`),
        JSON.stringify(record) + '\n',
      );
    } catch {
      /* best-effort */
    }
  };
}

/** gh-authenticated login for the audit record; `caller` ($USER) stays advisory. */
async function fetchGhLogin(runner: Runner, cwd?: string): Promise<string | null> {
  try {
    const out = await runner('gh', ['api', 'user', '--jq', '.login'], { cwd, allowFailure: true });
    const login = out.stdout.trim();
    return out.code === 0 && login !== '' ? login : null;
  } catch {
    return null;
  }
}

// ── Orchestration ───────────────────────────────────────────────────────

export interface RunReleaseMergeOptions {
  prNumber: number;
  repoSlug: string;
  runner: Runner;
  cwd?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  dryRun?: boolean;
  mode?: 'merge' | 'arm';
  /** Caller identity for the audit record (defaults to `$USER`). */
  caller?: string;
  /** Caller role (defaults to `resolveCallerRole()`). */
  callerRole?: string;
  /** Programmatic injection (tests): committed agent-role.yaml text. */
  policyYaml?: string | null;
  audit?: AuditWriter;
  now?: () => Date;
}

/**
 * Verify, from GitHub, that PR `prNumber` is a genuine release-please PR and
 * merge it (or arm auto-merge). Every step fails closed and every outcome is
 * audited.
 */
export async function runReleaseMerge(
  opts: RunReleaseMergeOptions,
): Promise<RunMergeIfEligibleResult> {
  const mode = opts.mode ?? 'merge';
  const resolvedRole = opts.callerRole ?? resolveCallerRole(process.env, opts.cwd ?? process.cwd());
  const callerRole = (resolvedRole ?? 'undetermined').toLowerCase();
  const audit = opts.audit ?? defaultAuditWriter();
  const now = opts.now ?? (() => new Date());
  const seen: { headSha?: string; commitsVerified?: boolean } = {};
  const ghLogin = await fetchGhLogin(opts.runner, opts.cwd);

  const finish = (
    result: RunMergeIfEligibleResult,
    outcome: ReleaseAuditRecord['outcome'],
  ): RunMergeIfEligibleResult => {
    audit({
      ts: now().toISOString(),
      event: 'release-merge',
      sourceKind: 'release',
      prNumber: opts.prNumber,
      repo: opts.repoSlug,
      caller: opts.caller ?? process.env.USER ?? 'unknown',
      ghLogin,
      commitsVerified: seen.commitsVerified,
      callerRole,
      mode,
      headSha: seen.headSha,
      outcome,
      reason: result.eligibility.reason,
    });
    return result;
  };
  const refuse = (reason: string): RunMergeIfEligibleResult =>
    finish(refusalResult(opts.prNumber, `release PR refused: ${reason}`, opts.dryRun), 'refused');

  // The policy is read from main as GitHub serves it, never from a local copy.
  let yamlText: string | null;
  if (opts.policyYaml !== undefined) {
    yamlText = opts.policyYaml;
  } else {
    const sha = await resolveMainSha(opts.repoSlug, opts.runner, opts.cwd);
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
    return refuse('could not read .ai-sdlc/agent-role.yaml from main as GitHub serves it');
  }
  const gov = resolveReleaseGovernance(yamlText);
  const { policy } = resolveGovernanceFromYaml(yamlText);

  // Caller-role mistake guard (not a security boundary; see module header).
  if (resolvedRole === null) {
    return refuse(
      'caller role could not be determined (no AI_SDLC_CALLER_ROLE, no active task) — set ' +
        'AI_SDLC_CALLER_ROLE explicitly to use --source-kind release',
    );
  }
  if (!gov.roles.includes(callerRole)) {
    return refuse(
      `caller role "${callerRole}" is not allowed to use --source-kind release ` +
        `(governance.releaseMergeRoles: ${gov.roles.join(', ') || '(none)'})`,
    );
  }
  if (gov.authors.length === 0) {
    return refuse(
      'no non-empty governance.releaseAuthors allow-list is configured on main (there is no ' +
        'fallback to mergeAuthors) — the release path is disabled (fail-closed)',
    );
  }

  const snap = await fetchPrSnapshot(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!snap) return refuse('could not read the PR from GitHub in one `gh pr view` call');
  seen.headSha = snap.headRefOid;

  if (snap.isCrossRepository !== false)
    return refuse('check "same-repo head": the PR is from a fork');
  if (snap.headRefName !== RELEASE_BRANCH) {
    return refuse(
      `check "head ref": "${snap.headRefName}" is not exactly "${RELEASE_BRANCH}" (release-please branch)`,
    );
  }
  if (snap.baseRefName !== 'main') {
    return refuse(`check "base branch": base is "${snap.baseRefName}", not "main"`);
  }
  if (!gov.authors.some((a) => a.toLowerCase() === snap.authorLogin.toLowerCase())) {
    return refuse(
      `check "PR author": "${snap.authorLogin}" is not on the release author allow-list ` +
        '(governance.releaseAuthors)',
    );
  }

  const commits = await fetchPrCommits(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!commits)
    return refuse('check "commit authors": could not list the PR commits (or too many)');
  const commitBad = commitAuthorRefusal(commits, gov.authors);
  if (commitBad) return refuse(`check "commit authors": ${commitBad}`);
  seen.commitsVerified = commits.every((c) => c.verified);
  if (commits[commits.length - 1].sha.toLowerCase() !== snap.headRefOid.toLowerCase()) {
    return refuse('check "commit authors": the commit list does not end at the PR head');
  }

  const baseSha = await resolveMainSha(opts.repoSlug, opts.runner, opts.cwd);
  const changed = baseSha
    ? await fetchChangedFiles(baseSha, snap.headRefOid, opts.repoSlug, opts.runner, opts.cwd)
    : null;
  if (!changed) {
    return refuse(
      'check "changed files": could not list every changed file (error or 300-file cap)',
    );
  }
  if (changed.length === 0) return refuse('check "changed files": the PR changes no files');
  const extra = nonReleaseFiles(changed);
  if (extra.length > 0) {
    return refuse(
      `check "changed files": not release artifacts: ${extra.slice(0, 5).join(', ')}` +
        `${extra.length > 5 ? `, +${extra.length - 5} more` : ''}`,
    );
  }

  const contentBad = await validateReleaseContent(
    changed,
    baseSha!,
    snap.headRefOid,
    opts.repoSlug,
    opts.runner,
    opts.cwd,
  );
  if (contentBad) return refuse(`check "file content": ${contentBad}`);

  // Checks, bound to the exact head commit.
  const required = await fetchRequiredChecks(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  let checks: RequiredCheckStatus[] = [];
  let checksSource: ChecksSource = 'required-contexts';
  let fetchFailed = required.fetchFailed;
  if (!required.fetchFailed) {
    const sha = await fetchShaChecks(snap.headRefOid, opts.repoSlug, opts.runner, opts.cwd);
    fetchFailed = sha.fetchFailed;
    if (required.checks.length > 0) {
      checks = required.checks.map((c) => ({
        name: c.name,
        state: stateForRequired(c.name, sha.checks),
      }));
    } else {
      checksSource = 'check-run-fallback';
      checks = sha.checks;
    }
  }

  // Arm and merge need the SAME readiness (all checks green + CLEAN), so there
  // is no window between verification and the merge GitHub performs.
  const eligibility = evaluateMergeEligibility({
    // The release path has its own gate; evaluate checks under an explicit grant.
    policy: { ...policy, allowMerge: 'onGreenClean' },
    sourceKind: 'release',
    releaseVerified: true,
    mergeStateStatus: snap.mergeStateStatus,
    requiredChecks: checks,
    checksSource,
    checksFetchFailed: fetchFailed,
  });
  if (!eligibility.eligible) return refuse(`check "required checks": ${eligibility.reason}`);
  const reason = eligibility.reason;

  const ok = (merged: boolean, armed: boolean): RunMergeIfEligibleResult => ({
    prNumber: opts.prNumber,
    policy,
    eligibility: { eligible: true, reason },
    merged,
    armed,
    dryRun: Boolean(opts.dryRun),
  });
  if (opts.dryRun) return finish(ok(false, false), 'dry-run');

  // Head pin: re-read, then let GitHub enforce it with --match-head-commit.
  const reread = await fetchPrSnapshot(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!reread) return refuse('could not re-read the PR immediately before merging');
  if (reread.headRefOid.toLowerCase() !== snap.headRefOid.toLowerCase()) {
    return refuse(
      `the PR head moved from ${snap.headRefOid} to ${reread.headRefOid} after verification`,
    );
  }
  if (reread.mergeStateStatus !== 'CLEAN') {
    return refuse(`mergeStateStatus="${reread.mergeStateStatus}" on the pre-merge re-read`);
  }
  const method = opts.mergeMethod ?? 'squash';
  const res =
    mode === 'arm'
      ? await armPr(opts.prNumber, opts.repoSlug, method, snap.headRefOid, opts.runner, opts.cwd)
      : await mergePr(opts.prNumber, opts.repoSlug, method, snap.headRefOid, opts.runner, opts.cwd);
  if (!res.ok) {
    return refuse(
      `GitHub refused the ${mode} (head pinned to ${snap.headRefOid}): ${res.error || '(no error text)'}`,
    );
  }
  return finish(
    mode === 'arm' ? ok(false, true) : ok(true, false),
    mode === 'arm' ? 'armed' : 'merged',
  );
}
