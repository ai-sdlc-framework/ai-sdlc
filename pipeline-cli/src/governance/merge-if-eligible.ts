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
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Locate AISDLC-601's CJS resolver module via a monorepo-relative path.
 * `pkgRoot` is this package's root (`pipeline-cli/`); the resolver lives at
 * `<repo-root>/ai-sdlc-plugin/hooks/lib/governance-resolver.js`, i.e. one
 * level above `pkgRoot`. Returns `null` when the file doesn't exist —
 * e.g. an adopter repo whose only `ai-sdlc-plugin` presence is a compiled
 * marketplace install with no `hooks/lib` source tree. Callers fail closed
 * to `STRICT_DEFAULTS` in that case (see `resolveRepoGovernancePolicy`).
 */
export function loadGovernanceResolverModule(pkgRoot: string): GovernanceResolverModule | null {
  const candidate = join(pkgRoot, '..', 'ai-sdlc-plugin', 'hooks', 'lib', 'governance-resolver.js');
  if (!existsSync(candidate)) return null;
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
  /** Raw state/conclusion string from `gh pr checks --required`. */
  state: string;
}

export interface MergeEligibilityContext {
  policy: GovernancePolicy;
  sourceKind: SourceKind | undefined;
  mergeStateStatus: string;
  /** The repo's REAL required-checks set — never a hardcoded subset. */
  requiredChecks: RequiredCheckStatus[];
}

export interface MergeEligibilityResult {
  eligible: boolean;
  /** Always populated — success rationale or refusal reason (auditable). */
  reason: string;
}

function isGreenState(state: string): boolean {
  return state.trim().toUpperCase() === 'SUCCESS';
}

/**
 * Pure evaluator — no IO. Order matters for the emitted `reason`: policy
 * gate first (cheapest, and callers should short-circuit fetching PR data
 * entirely when `allowMerge === 'never'`), then the OQ-2 trust boundary,
 * then mergeStateStatus, then the required-checks set.
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

// ── GitHub data plumbing (injectable Runner) ────────────────────────────

/**
 * Fetch the repo's REAL required-checks set for `prNumber` via
 * `gh pr checks --required`, which GitHub CLI resolves from actual branch
 * protection / the `ai-sdlc/pr-ready` rollup — never a hardcoded subset, so
 * opting into agent-merge removes only the "human clicks merge" step, never
 * a safety gate. Returns `[]` on any `gh` failure (the evaluator fails
 * closed on an empty set).
 */
export async function fetchRequiredChecks(
  prNumber: number,
  repoSlug: string,
  runner: Runner,
  cwd?: string,
): Promise<RequiredCheckStatus[]> {
  const out = await runner(
    'gh',
    ['pr', 'checks', String(prNumber), '--required', '--json', 'name,state', '--repo', repoSlug],
    { cwd, allowFailure: true },
  );
  if (out.code !== 0) return [];
  try {
    const parsed = JSON.parse(out.stdout) as Array<{ name: string; state: string }>;
    return parsed.map((p) => ({ name: p.name, state: p.state }));
  } catch {
    return [];
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

  const [mergeStateStatus, requiredChecks] = await Promise.all([
    fetchMergeStateStatus(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd),
    fetchRequiredChecks(opts.prNumber, opts.repoSlug, opts.runner, opts.cwd),
  ]);

  const eligibility = evaluateMergeEligibility({
    policy,
    sourceKind: opts.sourceKind,
    mergeStateStatus,
    requiredChecks,
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
