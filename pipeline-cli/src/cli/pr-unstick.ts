/**
 * `cli-pr-unstick` — deterministic PR-blocker auto-resolver (AISDLC-139).
 *
 * Built on the lesson that 3+ PRs got stuck on the same day in mechanically
 * detectable + mechanically fixable ways:
 *
 *   - chore-status-forwarding   stale forwarded statuses on AISDLC-87 attestor
 *                               commits (HEAD subject starts with
 *                               "chore(ci): sign review attestation")
 *   - rebase-when-behind        PR is BEHIND main; `gh pr update-branch --rebase`
 *   - docs-only-fallback        all changed files match docs paths-ignore but
 *                               `Post Review Results` never posted
 *   - stale-attestation         contentHashV3 mismatch after rebase; trigger an
 *                               empty no-op push so the verifier re-runs
 *   - backlog-drift             `Backlog Drift: failure` — REPORT ONLY (no
 *                               auto-fix; that's AISDLC-125 territory)
 *
 * Pattern: Stage A (deterministic) first; Stage B (LLM diagnosis) only when
 * Stage A finds nothing — emit a structured markdown prompt the operator can
 * paste into Claude Code instead of letting the agent investigate from
 * scratch every time.
 *
 * Mirrors the cli-deps shape exactly: a small module of pure functions, a
 * yargs router, and a bin shim. All `gh` / `git` calls go through an
 * injectable Runner so tests can stub the network.
 *
 * @module cli/pr-unstick
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { defaultRunner, type Runner } from '../runtime/exec.js';

// ── Types ─────────────────────────────────────────────────────────────

/** Required CI status contexts that must post for a PR to be mergeable. */
export const REQUIRED_STATUS_CONTEXTS = ['CI OK', 'Post Review Results', 'codecov/patch'] as const;

/** Globs (path-prefix or basename) considered docs-only. Mirrors the
 *  `paths-ignore` blocks in `verify-attestation.yml` and `ai-sdlc-review.yml`. */
export const DOCS_ONLY_PATTERNS = [
  /^spec\/rfcs\//,
  /^docs\//,
  /^backlog\/tasks\//,
  /^backlog\/completed\//,
  /^[^/]+\.md$/,
];

/** Subject prefix that identifies an AISDLC-87 CI attestor chore commit. */
export const CI_ATTESTOR_SUBJECT_PREFIX = 'chore(ci): sign review attestation';

export type CheckId =
  | 'chore-status-forwarding'
  | 'rebase-when-behind'
  | 'docs-only-fallback'
  | 'stale-attestation'
  | 'backlog-drift-report';

export interface CheckMatch {
  id: CheckId;
  /** Human-readable explanation of WHY this match fired. */
  reason: string;
  /** Action labels — what would (or did) happen. Not a command line; UI text. */
  actions: string[];
  /** Whether this check has an auto-fix or is report-only. */
  autoFixable: boolean;
}

export interface CheckOutcome extends CheckMatch {
  /**
   * `applied`  = auto-fix ran and succeeded
   * `dry-run`  = matched, but --dry-run skipped the mutation
   * `report`   = report-only (e.g. backlog-drift) — never mutates
   * `failed`   = mutation attempted and failed (error captured in `error`)
   */
  status: 'applied' | 'dry-run' | 'report' | 'failed';
  error?: string;
}

export interface PrInfo {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeStateStatus: string;
  mergeable: string;
  /** Files changed in the PR (path-only). */
  files: string[];
  /** HEAD commit message subject. */
  headSubject: string;
  /** HEAD commit's parent SHA(s) — first parent only is what we care about. */
  parentOid: string;
  /** Status contexts present at HEAD (state per context). */
  statusesAtHead: Map<string, string>;
  /** Status contexts present at parent (state per context). */
  statusesAtParent: Map<string, string>;
  /**
   * Check runs at HEAD keyed by name → conclusion (e.g. `Backlog Drift: failure`,
   * `ai-sdlc/attestation: success`). Lowercase-normalised conclusion.
   */
  checkRunsAtHead: Map<string, string>;
  /** Approving review count (latest review per author, only `APPROVED`). */
  approvingReviewCount: number;
}

export interface DetectOptions {
  pr: PrInfo;
}

export interface ResolveOptions {
  pr: PrInfo;
  matches: CheckMatch[];
  /** Repo `owner/repo` slug. */
  repoSlug: string;
  /** Per-PR worktree path or repo cwd for git operations. */
  cwd: string;
  dryRun: boolean;
  runner: Runner;
}

export interface PrUnstickResult {
  pr: PrInfo;
  matches: CheckMatch[];
  outcomes: CheckOutcome[];
  /** Set when `--all` skipped this PR or detection itself threw. */
  error?: string;
}

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Run all Stage A checks against `pr` and return every match in detection
 * order. Pure — no mutations, no shelling out. The caller decides whether to
 * apply or print the matches.
 */
export function detectAll(opts: DetectOptions): CheckMatch[] {
  const matches: CheckMatch[] = [];

  const choreMatch = detectChoreStatusForwarding(opts.pr);
  if (choreMatch) matches.push(choreMatch);

  const behindMatch = detectBehindMain(opts.pr);
  if (behindMatch) matches.push(behindMatch);

  const docsOnlyMatch = detectDocsOnlyMissingPostReview(opts.pr);
  if (docsOnlyMatch) matches.push(docsOnlyMatch);

  const staleAttestationMatch = detectStaleAttestation(opts.pr);
  if (staleAttestationMatch) matches.push(staleAttestationMatch);

  const driftMatch = detectBacklogDrift(opts.pr);
  if (driftMatch) matches.push(driftMatch);

  return matches;
}

/**
 * #1 Chore-status-forwarding: HEAD is an AISDLC-87 CI-attestor `[skip ci]`
 * chore commit, which suppresses every workflow. As a result the required
 * statuses at HEAD are MISSING but exist on the parent commit. We forward
 * them via the statuses API.
 */
export function detectChoreStatusForwarding(pr: PrInfo): CheckMatch | null {
  if (!pr.headSubject.startsWith(CI_ATTESTOR_SUBJECT_PREFIX)) return null;
  const missing: string[] = [];
  for (const ctx of REQUIRED_STATUS_CONTEXTS) {
    const headState = pr.statusesAtHead.get(ctx);
    const parentState = pr.statusesAtParent.get(ctx);
    if (headState !== 'success' && parentState === 'success') {
      missing.push(ctx);
    }
  }
  if (missing.length === 0) return null;
  return {
    id: 'chore-status-forwarding',
    reason: `HEAD is a CI-attestor [skip ci] chore commit; ${missing.length} required status(es) missing at HEAD but present on parent`,
    actions: missing.map((ctx) => `forward "${ctx}" → success @ ${pr.headRefOid.slice(0, 7)}`),
    autoFixable: true,
  };
}

/**
 * #2 PR is BEHIND main: `gh pr view --json mergeStateStatus` → `BEHIND`.
 * Auto-fix is `gh pr update-branch --rebase` (idempotent).
 */
export function detectBehindMain(pr: PrInfo): CheckMatch | null {
  if (pr.mergeStateStatus !== 'BEHIND') return null;
  return {
    id: 'rebase-when-behind',
    reason: 'PR is BEHIND main',
    actions: ['rebase against base via `gh pr update-branch --rebase`'],
    autoFixable: true,
  };
}

/**
 * #3 Docs-only PR missing `Post Review Results`: every file matches a
 * docs paths-ignore pattern but the workflow never posted the status.
 * The orthogonal `ai-sdlc-review-docs-only.yml` is supposed to post it,
 * but if it didn't (failure / race), we forward `Post Review Results: success`
 * via the statuses API. (This is the SAME repair as #1 but a different
 * trigger — different cause, same fix shape.)
 */
export function detectDocsOnlyMissingPostReview(pr: PrInfo): CheckMatch | null {
  if (pr.files.length === 0) return null;
  // Exclude the chore-status-forwarding case — that one is handled by #1
  // and has its own reason; avoid double-firing for the AISDLC-87 commit.
  if (pr.headSubject.startsWith(CI_ATTESTOR_SUBJECT_PREFIX)) return null;
  if (!pr.files.every(isDocsOnlyPath)) return null;
  const postReviewState = pr.statusesAtHead.get('Post Review Results');
  if (postReviewState === 'success') return null;
  return {
    id: 'docs-only-fallback',
    reason:
      'all changed files are docs-only but `Post Review Results` is missing/non-success at HEAD',
    actions: [`forward "Post Review Results" → success @ ${pr.headRefOid.slice(0, 7)}`],
    autoFixable: true,
  };
}

/**
 * #4 Stale local attestation after rebase: `ai-sdlc/attestation: failure`
 * AND ≥3 approving CI reviews. The 3-approval gate is what the AISDLC-87
 * CI attestor uses, so this signal also catches PRs that are otherwise
 * fully reviewed. Auto-fix is an empty no-op commit + `git push
 * --force-with-lease` to trigger verify-attestation re-run + (on the second
 * pass) the CI attestor's fresh signature.
 */
export function detectStaleAttestation(pr: PrInfo): CheckMatch | null {
  const att = pr.checkRunsAtHead.get('ai-sdlc/attestation');
  // Tolerate the contexts coming via either status (statusesAtHead) or check_run.
  const attestationStatusState = pr.statusesAtHead.get('ai-sdlc/attestation');
  const isFailure =
    (att !== undefined && att.toLowerCase() === 'failure') ||
    (attestationStatusState !== undefined && attestationStatusState.toLowerCase() === 'failure');
  if (!isFailure) return null;
  if (pr.approvingReviewCount < 3) return null;
  return {
    id: 'stale-attestation',
    reason: `ai-sdlc/attestation failed at HEAD with ${pr.approvingReviewCount} approving reviews — likely contentHashV3 drift after rebase`,
    actions: ['empty no-op commit + force-with-lease push to re-trigger verify-attestation'],
    autoFixable: true,
  };
}

/**
 * #5 Backlog-drift: `Backlog Drift: failure` check run at HEAD.
 * Report-only — auto-fix lives in AISDLC-125 (`backlog-drift fix --task ...`)
 * and we don't want to spend the AISDLC-87 hot path on it.
 */
export function detectBacklogDrift(pr: PrInfo): CheckMatch | null {
  const drift = pr.checkRunsAtHead.get('Backlog Drift');
  if (!drift || drift.toLowerCase() !== 'failure') return null;
  return {
    id: 'backlog-drift-report',
    reason: 'Backlog Drift CI check is failing',
    actions: ['REPORT ONLY — operator should run `npx backlog-drift fix --task <id>` (AISDLC-125)'],
    autoFixable: false,
  };
}

function isDocsOnlyPath(path: string): boolean {
  return DOCS_ONLY_PATTERNS.some((re) => re.test(path));
}

// ── Resolution (auto-fix) ────────────────────────────────────────────

/**
 * Apply auto-fixes for every `match` in `opts.matches`. Sequential so a fix
 * that mutates HEAD (e.g. stale-attestation push) doesn't race against a
 * concurrent status forward. Returns one outcome per match.
 *
 * `dryRun=true` short-circuits ALL mutations and tags every outcome with
 * `status: 'dry-run'` (or `'report'` for the non-fixable backlog-drift one).
 */
export async function resolveAll(opts: ResolveOptions): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const match of opts.matches) {
    const outcome = await resolveOne(match, opts);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function resolveOne(match: CheckMatch, opts: ResolveOptions): Promise<CheckOutcome> {
  if (!match.autoFixable) {
    // backlog-drift-report falls here.
    return { ...match, status: 'report' };
  }
  if (opts.dryRun) {
    return { ...match, status: 'dry-run' };
  }
  try {
    if (match.id === 'chore-status-forwarding') {
      await applyStatusForwarding(
        opts,
        match,
        REQUIRED_STATUS_CONTEXTS,
        'AISDLC-87 (skip ci marker) chore gap',
      );
    } else if (match.id === 'rebase-when-behind') {
      await applyRebase(opts);
    } else if (match.id === 'docs-only-fallback') {
      await applyStatusForwarding(opts, match, ['Post Review Results'], 'docs-only PR fallback');
    } else if (match.id === 'stale-attestation') {
      await applyNoOpPush(opts);
    } else {
      // Defensive: unknown auto-fixable id.
      return { ...match, status: 'failed', error: `no resolver wired for ${match.id}` };
    }
    return { ...match, status: 'applied' };
  } catch (err) {
    return {
      ...match,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * POST a commit status for each `context` whose HEAD entry is missing/non-success.
 * Used by both #1 (chore-status-forwarding) and #3 (docs-only-fallback).
 */
async function applyStatusForwarding(
  opts: ResolveOptions,
  _match: CheckMatch,
  contexts: readonly string[],
  description: string,
): Promise<void> {
  for (const ctx of contexts) {
    const headState = opts.pr.statusesAtHead.get(ctx);
    if (headState === 'success') continue; // already good
    await opts.runner(
      'gh',
      [
        'api',
        `repos/${opts.repoSlug}/statuses/${opts.pr.headRefOid}`,
        '-X',
        'POST',
        '-f',
        `state=success`,
        '-f',
        `context=${ctx}`,
        '-f',
        `description=forwarded by cli-pr-unstick — ${description}`,
      ],
      { cwd: opts.cwd },
    );
  }
}

async function applyRebase(opts: ResolveOptions): Promise<void> {
  await opts.runner('gh', ['pr', 'update-branch', '--rebase', String(opts.pr.number)], {
    cwd: opts.cwd,
  });
}

async function applyNoOpPush(opts: ResolveOptions): Promise<void> {
  // `git commit --allow-empty` requires a working tree. For --all sweeps this
  // would normally be the operator's main worktree which is read-only by
  // contract (CLAUDE.md). We require the operator to be sitting in the PR's
  // own worktree (cwd) — fail loudly otherwise so we don't accidentally push
  // an empty commit on main.
  const branchOut = await opts.runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: opts.cwd,
    allowFailure: true,
  });
  const currentBranch = branchOut.stdout.trim();
  if (currentBranch === 'main' || currentBranch === 'master' || currentBranch === 'HEAD') {
    throw new Error(
      `refusing to no-op-push from branch "${currentBranch}" — switch to the PR's worktree first`,
    );
  }
  await opts.runner(
    'git',
    ['commit', '--allow-empty', '-m', 'chore: trigger CI re-run for stale attestation'],
    { cwd: opts.cwd },
  );
  await opts.runner('git', ['push', '--force-with-lease'], { cwd: opts.cwd });
}

// ── Stage B prompt — LLM-fallback diagnosis ──────────────────────────

/**
 * Render a markdown prompt the operator can paste into Claude when Stage A
 * found no matches but the PR is still stuck. Encodes every signal Stage A
 * gathered so Claude doesn't have to re-discover it via gh / git.
 */
export function renderStageBPrompt(pr: PrInfo): string {
  const lines: string[] = [];
  lines.push(`# Stage B diagnosis prompt — PR #${pr.number}`);
  lines.push('');
  lines.push(`**Title:** ${pr.title}`);
  lines.push(`**Branch:** \`${pr.headRefName}\` → \`${pr.baseRefName}\``);
  lines.push(`**HEAD:** \`${pr.headRefOid}\` (subject: \`${pr.headSubject}\`)`);
  lines.push(`**mergeStateStatus:** ${pr.mergeStateStatus}`);
  lines.push(`**mergeable:** ${pr.mergeable}`);
  lines.push(`**Approving reviews:** ${pr.approvingReviewCount}`);
  lines.push('');
  lines.push('## Required statuses at HEAD');
  for (const ctx of REQUIRED_STATUS_CONTEXTS) {
    const state = pr.statusesAtHead.get(ctx) ?? '(missing)';
    lines.push(`- \`${ctx}\`: ${state}`);
  }
  lines.push('');
  lines.push('## Check runs at HEAD');
  if (pr.checkRunsAtHead.size === 0) {
    lines.push('_(none)_');
  } else {
    for (const [name, conclusion] of [...pr.checkRunsAtHead.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      lines.push(`- \`${name}\`: ${conclusion}`);
    }
  }
  lines.push('');
  lines.push('## Files changed');
  if (pr.files.length === 0) {
    lines.push('_(none)_');
  } else if (pr.files.length > 30) {
    for (const f of pr.files.slice(0, 30)) lines.push(`- \`${f}\``);
    lines.push(`- _(${pr.files.length - 30} more …)_`);
  } else {
    for (const f of pr.files) lines.push(`- \`${f}\``);
  }
  lines.push('');
  lines.push('## Why is this stuck?');
  lines.push('');
  lines.push(
    'Stage A deterministic checks all returned no match but the PR is still not green/MERGEABLE. ' +
      'Identify the root cause from the signals above. Cite specific status/check names. ' +
      'If the cause is mechanical, propose the exact `gh` / `git` command. ' +
      'If the cause is semantic (e.g. genuine review feedback, code conflict), say so explicitly.',
  );
  return lines.join('\n') + '\n';
}

// ── GitHub data plumbing ─────────────────────────────────────────────

/**
 * Fetch every signal we need for a PR in as few `gh` calls as possible.
 * Two calls per PR:
 *   - `gh pr view <n> --json files,...`  (pulls almost everything)
 *   - `gh api repos/{slug}/commits/{sha}/status`  for HEAD + parent
 *
 * The caller passes the repo slug so we don't have to resolve it per-PR.
 */
export async function fetchPrInfo(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<PrInfo> {
  const viewFields =
    'number,title,baseRefName,headRefName,headRefOid,mergeStateStatus,mergeable,files,reviews';
  const viewOut = await runner(
    'gh',
    ['pr', 'view', String(prNumber), '--json', viewFields, '--repo', repoSlug],
    { cwd },
  );
  const viewParsed = JSON.parse(viewOut.stdout) as RawPrView;

  // Walk the commit so we can read its subject + first parent.
  const commitOut = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${viewParsed.headRefOid}`,
      '--jq',
      '{message: .commit.message, parents: [.parents[].sha]}',
    ],
    { cwd },
  );
  const commitParsed = JSON.parse(commitOut.stdout) as { message: string; parents: string[] };
  const headSubject = (commitParsed.message ?? '').split('\n')[0] ?? '';
  const parentOid = commitParsed.parents?.[0] ?? '';

  // Combined status at HEAD + parent.
  const statusesAtHead = await fetchCombinedStatus(repoSlug, viewParsed.headRefOid, runner, cwd);
  const statusesAtParent = parentOid
    ? await fetchCombinedStatus(repoSlug, parentOid, runner, cwd)
    : new Map<string, string>();

  // Check runs at HEAD (different API surface from statuses).
  const checkRunsAtHead = await fetchCheckRuns(repoSlug, viewParsed.headRefOid, runner, cwd);

  return {
    number: viewParsed.number,
    title: viewParsed.title ?? '',
    baseRefName: viewParsed.baseRefName ?? '',
    headRefName: viewParsed.headRefName ?? '',
    headRefOid: viewParsed.headRefOid,
    mergeStateStatus: viewParsed.mergeStateStatus ?? 'UNKNOWN',
    mergeable: viewParsed.mergeable ?? 'UNKNOWN',
    files: (viewParsed.files ?? []).map((f) => f.path),
    headSubject,
    parentOid,
    statusesAtHead,
    statusesAtParent,
    checkRunsAtHead,
    approvingReviewCount: countApprovingReviews(viewParsed.reviews ?? []),
  };
}

async function fetchCombinedStatus(
  repoSlug: string,
  sha: string,
  runner: Runner,
  cwd?: string,
): Promise<Map<string, string>> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${sha}/status`,
      '--jq',
      '{statuses: [.statuses[] | {context, state}]}',
    ],
    { cwd, allowFailure: true },
  );
  const result = new Map<string, string>();
  if (out.code !== 0) return result;
  try {
    const parsed = JSON.parse(out.stdout) as {
      statuses: Array<{ context: string; state: string }>;
    };
    for (const s of parsed.statuses ?? []) {
      // Combined-status API returns the LATEST per context; just write through.
      result.set(s.context, s.state);
    }
  } catch {
    // ignore — empty map signals "no statuses".
  }
  return result;
}

async function fetchCheckRuns(
  repoSlug: string,
  sha: string,
  runner: Runner,
  cwd?: string,
): Promise<Map<string, string>> {
  const out = await runner(
    'gh',
    [
      'api',
      `repos/${repoSlug}/commits/${sha}/check-runs`,
      '--paginate',
      '--jq',
      '[.check_runs[]? | {name, conclusion}]',
    ],
    { cwd, allowFailure: true },
  );
  const result = new Map<string, string>();
  if (out.code !== 0) return result;
  try {
    const parsed = JSON.parse(out.stdout) as Array<{ name: string; conclusion: string | null }>;
    for (const r of parsed) {
      // Latest run wins (last write); GH returns runs in start-time order.
      result.set(r.name, r.conclusion ?? '');
    }
  } catch {
    // ignore
  }
  return result;
}

function countApprovingReviews(reviews: RawReview[]): number {
  // Per-author latest-wins: collapse to a Map of author → state, then count
  // entries whose final state was APPROVED.
  const byAuthor = new Map<string, string>();
  for (const r of reviews) {
    const login = r.author?.login ?? '(unknown)';
    if (!login) continue;
    byAuthor.set(login, r.state);
  }
  let n = 0;
  for (const state of byAuthor.values()) if (state === 'APPROVED') n++;
  return n;
}

interface RawPrView {
  number: number;
  title?: string;
  baseRefName?: string;
  headRefName?: string;
  headRefOid: string;
  mergeStateStatus?: string;
  mergeable?: string;
  files?: Array<{ path: string }>;
  reviews?: RawReview[];
}

interface RawReview {
  author?: { login?: string };
  state: string;
}

/**
 * Resolve `owner/repo` for the cwd. Used by --all to default the slug; for
 * single-PR mode we accept --repo as an override so the operator can target
 * any repo from any cwd.
 */
export async function resolveRepoSlug(runner: Runner, cwd?: string): Promise<string> {
  const out = await runner(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd },
  );
  return out.stdout.trim();
}

/**
 * Enumerate every open PR number in `repoSlug`. Used by --all.
 */
export async function listOpenPrs(
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<number[]> {
  const out = await runner(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number',
      '--jq',
      '[.[].number]',
      '--repo',
      repoSlug,
    ],
    { cwd },
  );
  try {
    return JSON.parse(out.stdout) as number[];
  } catch {
    return [];
  }
}

// ── Top-level orchestration (one PR + N PRs) ─────────────────────────

export interface RunOnePrOptions {
  prNumber: number;
  repoSlug: string;
  runner: Runner;
  cwd: string;
  dryRun: boolean;
}

export async function runForOnePr(opts: RunOnePrOptions): Promise<PrUnstickResult> {
  const pr = await fetchPrInfo(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd);
  const matches = detectAll({ pr });
  const outcomes = await resolveAll({
    pr,
    matches,
    repoSlug: opts.repoSlug,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    runner: opts.runner,
  });
  return { pr, matches, outcomes };
}

export interface RunAllOptions {
  repoSlug: string;
  runner: Runner;
  cwd: string;
  dryRun: boolean;
  /** Optional pre-built list of PR numbers (tests inject a fixture). */
  prNumbers?: number[];
}

/**
 * --all sweep: iterate every open PR sequentially. Per-PR errors are
 * captured into `result.error` and we keep going — a single broken PR
 * mustn't take down the whole sweep (that's what makes the operator dread
 * running this in the first place).
 */
export async function runForAllPrs(opts: RunAllOptions): Promise<PrUnstickResult[]> {
  const numbers = opts.prNumbers ?? (await listOpenPrs(opts.repoSlug, opts.runner, opts.cwd));
  const results: PrUnstickResult[] = [];
  for (const n of numbers) {
    try {
      const r = await runForOnePr({
        prNumber: n,
        repoSlug: opts.repoSlug,
        runner: opts.runner,
        cwd: opts.cwd,
        dryRun: opts.dryRun,
      });
      results.push(r);
    } catch (err) {
      // Use a synthetic stub PrInfo so downstream renderers don't have to
      // null-check. The error string communicates the failure.
      results.push({
        pr: stubPrInfo(n),
        matches: [],
        outcomes: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

function stubPrInfo(prNumber: number): PrInfo {
  return {
    number: prNumber,
    title: '(unavailable)',
    baseRefName: '',
    headRefName: '',
    headRefOid: '',
    mergeStateStatus: 'UNKNOWN',
    mergeable: 'UNKNOWN',
    files: [],
    headSubject: '',
    parentOid: '',
    statusesAtHead: new Map(),
    statusesAtParent: new Map(),
    checkRunsAtHead: new Map(),
    approvingReviewCount: 0,
  };
}

// ── Output rendering ─────────────────────────────────────────────────

export function renderTextResult(result: PrUnstickResult): string {
  const lines: string[] = [];
  const pr = result.pr;
  const prefix = `PR #${pr.number}`;
  if (result.error) {
    lines.push(`${prefix} | ERROR: ${result.error}`);
    return lines.join('\n') + '\n';
  }
  const subj = pr.headSubject ? ` ${pr.headSubject.slice(0, 60)}` : '';
  lines.push(`${prefix} |${subj} (${pr.mergeStateStatus}, ${pr.mergeable})`);
  if (result.matches.length === 0) {
    lines.push('  no Stage A matches');
    return lines.join('\n') + '\n';
  }
  for (let i = 0; i < result.matches.length; i++) {
    const m = result.matches[i];
    const o = result.outcomes[i];
    const tag =
      o.status === 'applied'
        ? 'APPLIED'
        : o.status === 'dry-run'
          ? 'DRY-RUN'
          : o.status === 'report'
            ? 'REPORT'
            : 'FAILED';
    lines.push(`  ✓ Stage A check (${m.id}) MATCHED [${tag}]`);
    lines.push(`    ${m.reason}`);
    for (const a of m.actions) lines.push(`    → ${a}`);
    if (o.error) lines.push(`    ERROR: ${o.error}`);
  }
  return lines.join('\n') + '\n';
}

export function renderJsonResult(results: PrUnstickResult[]): string {
  const serialised = results.map((r) => ({
    pr: serialisePr(r.pr),
    matches: r.matches,
    outcomes: r.outcomes,
    error: r.error ?? null,
  }));
  return JSON.stringify({ ok: true, results: serialised }, null, 2) + '\n';
}

function serialisePr(pr: PrInfo): unknown {
  return {
    number: pr.number,
    title: pr.title,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus,
    mergeable: pr.mergeable,
    headSubject: pr.headSubject,
    parentOid: pr.parentOid,
    files: pr.files,
    statusesAtHead: Object.fromEntries(pr.statusesAtHead),
    statusesAtParent: Object.fromEntries(pr.statusesAtParent),
    checkRunsAtHead: Object.fromEntries(pr.checkRunsAtHead),
    approvingReviewCount: pr.approvingReviewCount,
  };
}

// ── yargs CLI router ─────────────────────────────────────────────────

export interface BuildCliOptions {
  /** Inject a Runner — tests pass a fake; the bin shim defaults to live exec. */
  runner?: Runner;
}

export function buildPrUnstickCli(opts: BuildCliOptions = {}): Argv {
  const runner = opts.runner ?? defaultRunner;

  return yargs(hideBin(process.argv))
    .scriptName('cli-pr-unstick')
    .usage(
      'Usage: $0 [pr-number] [options]\n\n  cli-pr-unstick 176              # detect + auto-fix one PR\n  cli-pr-unstick 176 --dry-run    # detect, print proposed actions\n  cli-pr-unstick --all            # iterate every open PR\n  cli-pr-unstick --all --dry-run  # detect-only sweep',
    )
    .option('all', { type: 'boolean', default: false, describe: 'Iterate every open PR.' })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Detect + print, but do not mutate.',
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json'] as const,
      default: 'text' as const,
    })
    .option('repo', {
      type: 'string',
      describe: 'owner/repo slug (default: derived from cwd via `gh repo view`).',
    })
    .option('cwd', {
      type: 'string',
      describe: 'Working directory for git/gh calls (default: process.cwd()).',
    })
    .option('stage-b', {
      type: 'boolean',
      default: false,
      describe: 'Emit a Stage B diagnosis prompt for any PR with no Stage A matches.',
    })
    .option('auto-resolve', {
      type: 'boolean',
      default: false,
      describe:
        'Apply auto-fixes (default for non-dry-run). Present so the wake-up sentinel can pass it explicitly without ambiguity.',
    })
    .command(
      '$0 [pr-number]',
      'Detect + auto-resolve PR blockers',
      (y) =>
        y.positional('pr-number', {
          type: 'number',
          describe: 'Single PR to inspect (omit if --all).',
        }),
      async (argv) => {
        const cwd = (argv.cwd as string | undefined) ?? process.cwd();
        const dryRun = Boolean(argv['dry-run']);
        const format = String(argv.format) as 'text' | 'json';
        const stageB = Boolean(argv['stage-b']);
        const repoSlug = (argv.repo as string | undefined) ?? (await resolveRepoSlug(runner, cwd));

        let results: PrUnstickResult[];
        if (argv.all) {
          results = await runForAllPrs({ repoSlug, runner, cwd, dryRun });
        } else {
          const n = argv['pr-number'] as number | undefined;
          if (n === undefined || Number.isNaN(n)) {
            process.stderr.write(
              JSON.stringify({ ok: false, reason: 'pass a PR number or --all' }, null, 2) + '\n',
            );
            process.exit(1);
          }
          try {
            results = [await runForOnePr({ prNumber: n, repoSlug, runner, cwd, dryRun })];
          } catch (err) {
            process.stderr.write(
              JSON.stringify(
                { ok: false, reason: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ) + '\n',
            );
            process.exit(1);
          }
        }

        if (format === 'json') {
          process.stdout.write(renderJsonResult(results));
        } else {
          for (const r of results) {
            process.stdout.write(renderTextResult(r));
          }
        }

        if (stageB) {
          for (const r of results) {
            if (r.matches.length === 0 && !r.error) {
              process.stdout.write('\n' + renderStageBPrompt(r.pr));
            }
          }
        }

        // Exit non-zero only if every PR errored — partial successes
        // are still useful and the operator wants the green PRs surfaced.
        const allFailed = results.length > 0 && results.every((r) => Boolean(r.error));
        if (allFailed) process.exit(1);
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Bin shim entry point. The mjs shim imports + invokes this.
 */
export async function runPrUnstickCli(): Promise<void> {
  await buildPrUnstickCli().parseAsync();
}
