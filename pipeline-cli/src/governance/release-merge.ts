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
 *    (falling back to `governance.mergeAuthors`) and that one unlinked
 *    release-bot identity. No login is hardcoded here.
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

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  const authors =
    clean(raw['releaseAuthors'], LOGIN_RE, 39) ??
    resolveGovernanceFromYaml(yamlText).mergeAuthors.slice();
  return { roles: roles.map((r) => r.toLowerCase()), authors };
}

/**
 * Caller role: `AI_SDLC_CALLER_ROLE` when set; otherwise a session that carries
 * an active task id (a dispatched developer/executor) is `executor`, and a
 * bare session is `operator`. Environment-derived, so a MISTAKE GUARD only.
 */
export function resolveCallerRole(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AI_SDLC_CALLER_ROLE?.trim().toLowerCase();
  if (explicit) return explicit;
  return env.AI_SDLC_ACTIVE_TASK_ID?.trim() ? 'executor' : 'operator';
}

// ── PR commits ──────────────────────────────────────────────────────────

export interface PrCommit {
  sha: string;
  /** Linked GitHub login of the author, or null when the email is unlinked. */
  authorLogin: string | null;
  authorEmail: string;
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
      '.[] | {sha, login: .author.login, email: .commit.author.email}',
    ],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return null;
  try {
    const commits = out.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { sha?: unknown; login?: unknown; email?: unknown });
    const parsed: PrCommit[] = [];
    for (const c of commits) {
      if (typeof c.sha !== 'string' || typeof c.email !== 'string') return null;
      parsed.push({
        sha: c.sha,
        authorLogin: typeof c.login === 'string' ? c.login : null,
        authorEmail: c.email,
      });
    }
    return parsed.length === 0 || parsed.length >= PR_COMMITS_CAP ? null : parsed;
  } catch {
    return null;
  }
}

/** Refusal reason for the first commit not authored by an allowed release identity, else null. */
export function commitAuthorRefusal(commits: PrCommit[], authors: string[]): string | null {
  const allowed = (l: string) => authors.some((a) => a.toLowerCase() === l.toLowerCase());
  for (const c of commits) {
    if (c.authorLogin !== null) {
      if (!allowed(c.authorLogin)) {
        return `commit ${c.sha.slice(0, 8)} is authored by "${c.authorLogin}", not an allowed release identity`;
      }
    } else if (c.authorEmail.toLowerCase() !== RELEASE_BOT_EMAIL) {
      return `commit ${c.sha.slice(0, 8)} has an unlinked author "${c.authorEmail}", not the release bot (${RELEASE_BOT_EMAIL})`;
    }
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
  const callerRole = (opts.callerRole ?? resolveCallerRole()).toLowerCase();
  const audit = opts.audit ?? defaultAuditWriter();
  const now = opts.now ?? (() => new Date());
  const seen: { headSha?: string } = {};

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
  if (!gov.roles.includes(callerRole)) {
    return refuse(
      `caller role "${callerRole}" is not allowed to use --source-kind release ` +
        `(governance.releaseMergeRoles: ${gov.roles.join(', ') || '(none)'})`,
    );
  }
  if (gov.authors.length === 0) {
    return refuse(
      'no governance.releaseAuthors (or mergeAuthors) allow-list is configured on main — an empty ' +
        'list trusts nobody (fail-closed)',
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
        '(governance.releaseAuthors / mergeAuthors)',
    );
  }

  const commits = await fetchPrCommits(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  if (!commits)
    return refuse('check "commit authors": could not list the PR commits (or too many)');
  const commitBad = commitAuthorRefusal(commits, gov.authors);
  if (commitBad) return refuse(`check "commit authors": ${commitBad}`);
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

  let reason: string;
  if (mode === 'arm') {
    // Arming waits for checks; refuse only when a check has already failed.
    if (fetchFailed) return refuse('check "required checks": the checks fetch failed');
    const failed = checks.filter((c) => {
      const s = c.state.trim().toUpperCase();
      return !['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PENDING', 'IN_PROGRESS', 'QUEUED'].includes(s);
    });
    if (failed.length > 0) {
      return refuse(
        `check "required checks": not green: ${failed.map((c) => `${c.name}=${c.state}`).join(', ')}`,
      );
    }
    reason =
      `release PR verified for head ${snap.headRefOid} — eligible to arm auto-merge ` +
      '(GitHub merges only once its own required checks pass)';
  } else {
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
    reason = eligibility.reason;
  }

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
  if (mode === 'merge' && reread.mergeStateStatus !== 'CLEAN') {
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
