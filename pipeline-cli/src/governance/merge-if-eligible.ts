/**
 * `merge-if-eligible` — deterministic merge gate (RFC-0048 Phase 3 / AISDLC-603).
 *
 * The green+CLEAN merge gate MUST live in a deterministic CLI helper, never
 * in LLM-honored command-body prose ("anything mechanical → hook/workflow,
 * never LLM" per the framework's governing principle). This module is that
 * helper's pure core: it resolves the repo's `spec.governance` policy
 * (AISDLC-601's resolver), evaluates a PR's real required-checks state +
 * `mergeStateStatus` + work-item `sourceKind` against that policy, and
 * refuses (with an auditable reason) unless every condition holds.
 *
 * AISDLC-602 will make this helper the ONLY merge route (its reconciled
 * hook blocks raw `gh pr merge`) — this task only builds the helper.
 *
 * Design decisions:
 *
 *  - **`sourceKind` is an explicit input, never inferred from PR content.**
 *    Every other AISDLC-393 call site (`composeTitle`, `composeBody` in
 *    `steps/11-push-and-pr.ts`) threads `sourceKind` through as an option
 *    supplied by the pipeline that knows the work item's provenance — this
 *    helper follows the same contract. Inferring trust from PR body/branch
 *    text (e.g. scanning for "Closes #") would let an adversarial PR spoof
 *    trust by copying that text; an explicit caller-supplied value keeps the
 *    trust boundary at the pipeline that actually dispatched the work.
 *  - **Fail-closed on every axis.** An unresolved/malformed policy resolves
 *    to `STRICT_DEFAULTS` (mirrors AISDLC-601). A `sourceKind` that isn't
 *    literally `'backlog'` is untrusted. An empty required-checks list is
 *    treated as a fetch/config problem and refused, not treated as
 *    vacuously green.
 *  - **All GitHub/gh calls go through the injectable `Runner` seam** (same
 *    pattern as `cli/pr-unstick.ts`), and policy resolution is injectable
 *    too, so hermetic tests never shell out or touch the filesystem.
 *
 * @module governance/merge-if-eligible
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

interface GovernanceResolverModule {
  resolveGovernanceFromYaml(yamlText: string): GovernancePolicy;
}

// ── Installed-plugin resolver-path resolution (AISDLC-607 Defect 1) ─────

/**
 * Numeric, dot-separated version compare. Missing/non-numeric segments sort
 * as 0. Mirrors `agent-dir-resolver.ts`'s `compareVersionStrings` (AISDLC-583)
 * — duplicated rather than imported so this module has no cross-directory
 * coupling to the attestation package for a two-line helper.
 */
function compareVersionStrings(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Default plugin-cache root: `~/.claude/plugins/cache`. */
export function defaultPluginCacheRoot(): string {
  return join(homedir(), '.claude', 'plugins', 'cache');
}

/**
 * Walk `<cacheRoot>/<marketplace>/ai-sdlc/<version>/hooks/lib/governance-resolver.js`
 * across every marketplace cache dir, returning the highest-version match (or
 * `null` when the cache root doesn't exist or nothing matches).
 *
 * `cacheRoot` is injectable so the walk is deterministic in hermetic tests
 * (CI runners have no real `~/.claude/plugins/cache`) — mirrors
 * `highestVersionCacheAgentsDir` in `attestation/agent-dir-resolver.ts`
 * (AISDLC-583).
 */
export function highestVersionCacheGovernanceResolverPath(
  cacheRoot: string = defaultPluginCacheRoot(),
): string | null {
  if (!existsSync(cacheRoot)) return null;

  let marketplaces: string[];
  try {
    marketplaces = readdirSync(cacheRoot);
  } catch {
    return null;
  }

  let best: { version: string; path: string } | null = null;
  for (const marketplace of marketplaces) {
    const versionsDir = join(cacheRoot, marketplace, 'ai-sdlc');
    if (!existsSync(versionsDir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(versionsDir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = join(versionsDir, version, 'hooks', 'lib', 'governance-resolver.js');
      if (!existsSync(candidate)) continue;
      if (!best || compareVersionStrings(version, best.version) > 0) {
        best = { version, path: candidate };
      }
    }
  }
  return best?.path ?? null;
}

/**
 * Resolve the INSTALLED Claude Code plugin's `governance-resolver.js` path
 * (AISDLC-607 Defect 1). A marketplace/npm consumer install never has
 * `ai-sdlc-plugin` as a sibling of `pipeline-cli/` — the pre-fix monorepo-only
 * lookup returned `null` on 100% of adopter repos, silently downgrading a
 * correctly-configured `allowMerge: onGreenClean` policy to `STRICT_DEFAULTS`.
 *
 * Resolution order (first existing match wins):
 *   1. `$CLAUDE_PLUGIN_ROOT/hooks/lib/governance-resolver.js` /
 *      `$CLAUDE_PLUGIN_DIR/hooks/lib/governance-resolver.js` — set by the
 *      Claude Code harness for a standard marketplace install.
 *   2. `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/hooks/lib/governance-resolver.js`
 *      — the plugin cache probe; highest installed version wins.
 *
 * Returns `null` when neither resolves — never throws. The caller
 * (`loadGovernanceResolverModule`) falls back to the monorepo-sibling path
 * (dogfood), then finally to `null` (fail-closed to `STRICT_DEFAULTS`).
 */
export function resolveInstalledPluginGovernanceResolverPath(cacheRoot?: string): string | null {
  for (const pluginDir of [process.env['CLAUDE_PLUGIN_ROOT'], process.env['CLAUDE_PLUGIN_DIR']]) {
    if (!pluginDir) continue;
    const candidate = join(pluginDir, 'hooks', 'lib', 'governance-resolver.js');
    if (existsSync(candidate)) return candidate;
  }
  return highestVersionCacheGovernanceResolverPath(cacheRoot);
}

/**
 * Locate AISDLC-601's CJS resolver module. Tries, in order: the INSTALLED
 * plugin (env-var-pointed or cache-probed — AISDLC-607 Defect 1), then the
 * monorepo-sibling path (`<repo-root>/ai-sdlc-plugin/hooks/lib/governance-resolver.js`,
 * one level above `pkgRoot`, dogfood-only). Returns `null` when NEITHER
 * resolves — e.g. an adopter repo with no plugin install signal at all.
 * Callers fail closed to `STRICT_DEFAULTS` in that case (see
 * `resolveRepoGovernancePolicy`) — this preserves AC-2's fail-closed
 * guarantee; only the false-negative (resolver present in an installed
 * plugin but not found) is fixed.
 */
export function loadGovernanceResolverModule(
  pkgRoot: string,
  cacheRoot?: string,
): GovernanceResolverModule | null {
  const installedCandidate = resolveInstalledPluginGovernanceResolverPath(cacheRoot);
  const monorepoCandidate = join(
    pkgRoot,
    '..',
    'ai-sdlc-plugin',
    'hooks',
    'lib',
    'governance-resolver.js',
  );
  const candidate =
    installedCandidate ?? (existsSync(monorepoCandidate) ? monorepoCandidate : null);
  if (!candidate) return null;
  const require = createRequire(import.meta.url);
  return require(candidate) as GovernanceResolverModule;
}

/**
 * Resolve the repo's governance policy from a TRUSTED base-branch checkout.
 *
 * `repoRoot` MUST point at the operator/base checkout on disk — NOT a PR
 * worktree — so the governed party can never relax its own rules by editing
 * `.ai-sdlc/agent-role.yaml` inside the PR diff (mirrors the trust-boundary
 * contract documented in `governance-resolver.js`'s file header and honored
 * by every existing caller, `session-start.js` / `subagent-start.js`).
 *
 * Absent `agent-role.yaml`, absent `governance:` block, or an unresolvable
 * resolver module all fail closed to `STRICT_DEFAULTS` — never a laxer
 * default.
 */
export function resolveRepoGovernancePolicy(
  repoRoot: string,
  pkgRoot: string,
  resolverModule?: GovernanceResolverModule | null,
): GovernancePolicy {
  const mod = resolverModule !== undefined ? resolverModule : loadGovernanceResolverModule(pkgRoot);
  if (!mod) return { ...STRICT_DEFAULTS };

  const agentRolePath = join(repoRoot, '.ai-sdlc', 'agent-role.yaml');
  let yamlText = '';
  if (existsSync(agentRolePath)) {
    try {
      yamlText = readFileSync(agentRolePath, 'utf-8');
    } catch {
      yamlText = '';
    }
  }
  try {
    return mod.resolveGovernanceFromYaml(yamlText);
  } catch {
    return { ...STRICT_DEFAULTS };
  }
}

// ── Work-item trust boundary (OQ-2) ─────────────────────────────────────

/**
 * `sourceKind` values threaded through the pipeline since AISDLC-393
 * (`'backlog' | 'gh-issue'`). Only `'backlog'` (internal, dispatched by our
 * own orchestrator) is trusted for agent-initiated merge. `'gh-issue'`
 * (external GitHub issue / contributor-authored work) and any unrecognised
 * value are untrusted — fail closed.
 */
export type SourceKind = 'backlog' | 'gh-issue';

export function isTrustedSourceKind(sourceKind: SourceKind | undefined): boolean {
  return sourceKind === 'backlog';
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
  if (ctx.policy.allowMerge !== 'onGreenClean') {
    return {
      eligible: false,
      reason:
        `governance policy allowMerge="${ctx.policy.allowMerge}" — refusing all agent-initiated ` +
        'merges (strict default requires a human to click merge; set governance.allowMerge: ' +
        'onGreenClean in .ai-sdlc/agent-role.yaml to opt in)',
    };
  }

  if (!isTrustedSourceKind(ctx.sourceKind)) {
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
        'sourceKind=backlog (trusted) — eligible for agent-initiated merge',
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
      'SUCCESS/NEUTRAL (none pending), mergeStateStatus=CLEAN, sourceKind=backlog (trusted) — ' +
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
 * Fetch the repo's REAL required-checks set for `prNumber` via
 * `gh pr checks --required`, which GitHub CLI resolves from actual branch
 * protection / the `ai-sdlc/pr-ready` rollup — never a hardcoded subset, so
 * opting into agent-merge removes only the "human clicks merge" step, never
 * a safety gate. `checks: []` + `fetchFailed: false` means the fetch
 * SUCCEEDED with zero required contexts configured (e.g. no branch
 * protection) — the caller falls back to `fetchAllCheckRuns`. `fetchFailed:
 * true` means the fetch itself errored — the caller MUST fail closed rather
 * than falling back (AC-5).
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
  if (out.code !== 0) return { checks: [], fetchFailed: true };
  try {
    const parsed = JSON.parse(out.stdout) as Array<{ name: string; state: string }>;
    return { checks: parsed.map((p) => ({ name: p.name, state: p.state })), fetchFailed: false };
  } catch {
    return { checks: [], fetchFailed: true };
  }
}

/**
 * Fetch the PR's REAL (unfiltered) check-runs via `gh pr checks` (no
 * `--required`) — used as the AISDLC-607 Defect 2 fallback when
 * `fetchRequiredChecks` succeeds but finds zero required contexts (a repo
 * with no branch protection configured). Same fetch-failure semantics as
 * `fetchRequiredChecks`: `fetchFailed: true` on non-zero `gh` exit or
 * unparseable output, never silently treated as an empty-but-successful
 * fetch.
 */
export async function fetchAllCheckRuns(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<ChecksFetchResult> {
  const out = await runner(
    'gh',
    ['pr', 'checks', String(prNumber), '--json', 'name,state', '--repo', repoSlug],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return { checks: [], fetchFailed: true };
  try {
    const parsed = JSON.parse(out.stdout) as Array<{ name: string; state: string }>;
    return { checks: parsed.map((p) => ({ name: p.name, state: p.state })), fetchFailed: false };
  } catch {
    return { checks: [], fetchFailed: true };
  }
}

/** Fetch `mergeStateStatus` for `prNumber` via `gh pr view`. */
export async function fetchMergeStateStatus(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<string> {
  const out = await runner(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'mergeStateStatus', '--repo', repoSlug],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return 'UNKNOWN';
  try {
    const parsed = JSON.parse(out.stdout) as { mergeStateStatus?: string };
    return parsed.mergeStateStatus ?? 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/** `gh pr merge` — the ONLY mutation this module performs, and only when eligible. */
export async function mergePr(
  prNumber: number,
  repoSlug: string,
  mergeMethod: 'squash' | 'merge' | 'rebase',
  runner: Runner,
  cwd?: string,
): Promise<void> {
  await runner('gh', ['pr', 'merge', String(prNumber), `--${mergeMethod}`, '--repo', repoSlug], {
    cwd,
  });
}

export async function resolveRepoSlug(runner: Runner, cwd?: string): Promise<string> {
  const out = await runner(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd },
  );
  return out.stdout.trim();
}

// ── Top-level orchestration ──────────────────────────────────────────────

export interface RunMergeIfEligibleOptions {
  prNumber: number;
  sourceKind: SourceKind | undefined;
  repoSlug: string;
  /** Trusted base-branch checkout to read `.ai-sdlc/agent-role.yaml` from. */
  repoRoot: string;
  /** This package's root, used to locate the CJS governance resolver. */
  pkgRoot: string;
  runner: Runner;
  cwd?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  dryRun?: boolean;
  /** Injection seam for hermetic tests — bypasses filesystem policy read. */
  loadPolicy?: (repoRoot: string, pkgRoot: string) => GovernancePolicy;
}

export interface RunMergeIfEligibleResult {
  prNumber: number;
  policy: GovernancePolicy;
  eligibility: MergeEligibilityResult;
  merged: boolean;
  dryRun: boolean;
}

/**
 * Compose policy resolution + PR-state fetch + evaluation + (conditionally)
 * the merge call. Short-circuits the `gh` fetches entirely when the policy
 * is strict — no need to query PR state for a merge that's refused
 * unconditionally.
 */
export async function runMergeIfEligible(
  opts: RunMergeIfEligibleOptions,
): Promise<RunMergeIfEligibleResult> {
  const policy =
    opts.loadPolicy?.(opts.repoRoot, opts.pkgRoot) ??
    resolveRepoGovernancePolicy(opts.repoRoot, opts.pkgRoot);

  if (policy.allowMerge !== 'onGreenClean') {
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

  // Trust boundary can also short-circuit before spending a network call.
  if (!isTrustedSourceKind(opts.sourceKind)) {
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

  const [mergeStateStatus, requiredResult] = await Promise.all([
    fetchMergeStateStatus(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd),
    fetchRequiredChecks(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd),
  ]);

  // AISDLC-607 Defect 2: distinguish "branch protection has no required
  // contexts" (successful fetch, empty array → fall back to real check-runs)
  // from "the required-checks fetch itself failed/errored" (fail closed,
  // NEVER fall back — AC-5).
  let requiredChecks: RequiredCheckStatus[];
  let checksSource: ChecksSource;
  let checksFetchFailed: boolean;

  if (requiredResult.fetchFailed) {
    checksSource = 'required-contexts';
    checksFetchFailed = true;
    requiredChecks = [];
  } else if (requiredResult.checks.length > 0) {
    // Required contexts ARE configured — byte-identical historical path (AC-6).
    checksSource = 'required-contexts';
    checksFetchFailed = false;
    requiredChecks = requiredResult.checks;
  } else {
    // Fetch succeeded but found zero required contexts (no branch
    // protection) — fall back to the PR's real check-runs.
    const fallbackResult = await fetchAllCheckRuns(
      opts.prNumber,
      opts.repoSlug,
      opts.runner,
      opts.cwd,
    );
    checksSource = 'check-run-fallback';
    checksFetchFailed = fallbackResult.fetchFailed;
    requiredChecks = fallbackResult.checks;
  }

  const eligibility = evaluateMergeEligibility({
    policy,
    sourceKind: opts.sourceKind,
    mergeStateStatus,
    requiredChecks,
    checksSource,
    checksFetchFailed,
  });

  let merged = false;
  if (eligibility.eligible && !opts.dryRun) {
    await mergePr(
      opts.prNumber,
      opts.repoSlug,
      opts.mergeMethod ?? 'squash',
      opts.runner,
      opts.cwd,
    );
    merged = true;
  }

  return { prNumber: opts.prNumber, policy, eligibility, merged, dryRun: Boolean(opts.dryRun) };
}
