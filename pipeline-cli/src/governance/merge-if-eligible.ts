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
 *  - **Trust is derived from GitHub data, not from `sourceKind` alone.** On top
 *    of the caller-supplied `sourceKind` (kept as an additional input), the
 *    helper requires facts read from the PR itself: same-repo (not a fork),
 *    base branch `main`, an author on the policy's `mergeAuthors` allow-list,
 *    and a matching backlog task (see `evaluatePrTrust`). Policy and the
 *    allow-list are read ONLY from the verified main checkout.
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
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
  /** Absent on older installed plugin versions — the allow-list then resolves to `[]` (refuse). */
  resolveMergeAuthorsFromYaml?(yamlText: string): string[];
}

/** The slice of `hooks/lib/trusted-policy.js` this module uses. */
export interface TrustedPolicyModule {
  verifiedMainRoot(dir: string): string | null;
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
    // Filter to directories: a stray file at the marketplace level would be
    // skipped by the downstream existsSync guards anyway, but the explicit
    // filter makes the walk's intent clear.
    marketplaces = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }

  let best: { version: string; path: string } | null = null;
  for (const marketplace of marketplaces) {
    const versionsDir = join(cacheRoot, marketplace, 'ai-sdlc');
    if (!existsSync(versionsDir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(versionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
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
 *
 * `locateGovernanceResolverPaths` returns EVERY existing candidate in that
 * preference order (installed plugin first, then the monorepo sibling).
 */
export function locateGovernanceResolverPaths(pkgRoot: string, cacheRoot?: string): string[] {
  const installedCandidate = resolveInstalledPluginGovernanceResolverPath(cacheRoot);
  const monorepoCandidate = join(
    pkgRoot,
    '..',
    'ai-sdlc-plugin',
    'hooks',
    'lib',
    'governance-resolver.js',
  );
  const out: string[] = [];
  if (installedCandidate) out.push(installedCandidate);
  if (existsSync(monorepoCandidate) && monorepoCandidate !== installedCandidate) {
    out.push(monorepoCandidate);
  }
  return out;
}

export function loadGovernanceResolverModule(
  pkgRoot: string,
  cacheRoot?: string,
): GovernanceResolverModule | null {
  const candidate = locateGovernanceResolverPaths(pkgRoot, cacheRoot)[0];
  if (!candidate) return null;
  const require = createRequire(import.meta.url);
  return require(candidate) as GovernanceResolverModule;
}

/**
 * Load `trusted-policy.js` from the first plugin `hooks/lib` directory (same
 * installed-plugin then monorepo-sibling order as the resolver) that has one:
 * an older installed plugin without it falls through to the next candidate.
 * `null` when none loads: the caller then cannot establish a verified main
 * checkout and MUST refuse (fail closed).
 */
export function loadTrustedPolicyModule(
  pkgRoot: string,
  cacheRoot?: string,
): TrustedPolicyModule | null {
  const require = createRequire(import.meta.url);
  for (const resolverPath of locateGovernanceResolverPaths(pkgRoot, cacheRoot)) {
    const candidate = join(dirname(resolverPath), 'trusted-policy.js');
    if (!existsSync(candidate)) continue;
    try {
      const mod = require(candidate) as Partial<TrustedPolicyModule>;
      if (typeof mod.verifiedMainRoot === 'function') return mod as TrustedPolicyModule;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * TEST-ONLY escape hatch. When set to exactly `1`, an explicit `--repo-root`
 * is honoured instead of the verified main checkout. Production invocations
 * never set this; without it `--repo-root` is ignored.
 */
export const TEST_ONLY_POLICY_ROOT_ENV = 'AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS';

export interface TrustedRootResult {
  /** The verified main checkout, or `null` when none could be established. */
  root: string | null;
  /** Why `root` is null (empty when it is set). */
  reason: string;
  /** True when the test-only override supplied `root`. */
  testOverride: boolean;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Establish the trusted policy root. Production: the MAIN checkout (git common
 * dir, cross-checked against the filesystem by `verifiedMainRoot`) of the repo
 * that contains the running CLI (`anchorDir`), and it must be the SAME main
 * checkout the invocation's `cwd` belongs to — otherwise an agent could `cd`
 * into a repo it controls and have that repo's policy honoured. A missing or
 * unverifiable main root yields `root: null` (the caller refuses).
 *
 * The `--repo-root` override is honoured only when `AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS=1`.
 */
export function resolveTrustedMainRoot(opts: {
  cwd: string;
  anchorDir: string;
  repoRootOverride?: string;
  trustedModule: TrustedPolicyModule | null;
  env?: NodeJS.ProcessEnv;
}): TrustedRootResult {
  const env = opts.env ?? process.env;
  if (env[TEST_ONLY_POLICY_ROOT_ENV] === '1' && opts.repoRootOverride) {
    return { root: opts.repoRootOverride, reason: '', testOverride: true };
  }
  const refuse = (reason: string): TrustedRootResult => ({
    root: null,
    reason,
    testOverride: false,
  });
  if (!opts.trustedModule) {
    return refuse(
      'the trusted-policy helper (plugin hooks/lib/trusted-policy.js) could not be loaded',
    );
  }
  let anchorMain: string | null;
  let cwdMain: string | null;
  try {
    anchorMain = opts.trustedModule.verifiedMainRoot(opts.anchorDir);
    cwdMain = opts.trustedModule.verifiedMainRoot(opts.cwd);
  } catch {
    return refuse('verifying the main checkout failed');
  }
  if (!anchorMain) {
    return refuse('could not verify the main checkout of the repo containing this CLI');
  }
  if (!cwdMain || safeReal(cwdMain) !== safeReal(anchorMain)) {
    return refuse(
      'the working directory does not belong to the same verified main checkout as this CLI',
    );
  }
  return { root: anchorMain, reason: '', testOverride: false };
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

/**
 * Read the `spec.governance.mergeAuthors` allow-list (GitHub logins whose PRs
 * the agent may merge) from the SAME trusted main-checkout `agent-role.yaml`
 * as the policy. Absent key, malformed value, missing resolver support or an
 * unreadable file all yield `[]`, and an empty list refuses every merge.
 */
export function resolveRepoMergeAuthors(
  repoRoot: string,
  pkgRoot: string,
  resolverModule?: GovernanceResolverModule | null,
): string[] {
  let mod: GovernanceResolverModule | null | undefined = resolverModule;
  if (mod === undefined) {
    // An older installed plugin may predate the allow-list: use the first
    // candidate resolver that supports it.
    mod = null;
    const require = createRequire(import.meta.url);
    for (const path of locateGovernanceResolverPaths(pkgRoot)) {
      try {
        const candidate = require(path) as GovernanceResolverModule;
        if (typeof candidate.resolveMergeAuthorsFromYaml === 'function') {
          mod = candidate;
          break;
        }
      } catch {
        // try the next candidate
      }
    }
  }
  if (!mod || typeof mod.resolveMergeAuthorsFromYaml !== 'function') return [];
  try {
    const text = readFileSync(join(repoRoot, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
    const list = mod.resolveMergeAuthorsFromYaml(text);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
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

const TASK_ID_BODY = '[A-Za-z][A-Za-z0-9]*-\\d+(?:\\.\\d+)*';
const BRANCH_TASK_ID = new RegExp(`^ai-sdlc/(${TASK_ID_BODY})(?:-|$)`);
const TITLE_TASK_ID = new RegExp(`\\((${TASK_ID_BODY})\\)\\s*$`);

/**
 * Derive the backlog task id for a PR from its head branch (`ai-sdlc/<id>-...`,
 * the repo's branch convention) and/or its title (trailing `(<ID>)`). When both
 * yield an id they must agree. Neither → `null`.
 */
export function deriveTaskId(
  headRefName: string,
  title: string,
): { taskId: string | null; conflict?: string } {
  const fromBranch = BRANCH_TASK_ID.exec(headRefName)?.[1];
  const fromTitle = TITLE_TASK_ID.exec(title.trim())?.[1];
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

/** Does a matching task file exist on `origin/main`? (`git ls-tree`, no network.) */
export async function taskFileOnOriginMain(
  taskId: string,
  repoRoot: string,
  runner: Runner,
): Promise<boolean> {
  const out = await runner(
    'git',
    ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/tasks', 'backlog/completed'],
    { cwd: repoRoot, allowFailure: true },
  );
  if (out.code !== 0) return false;
  return out.stdout.split('\n').some((line) => isBacklogTaskFileFor(taskId, line.trim()));
}

/**
 * Evaluate the GitHub-derived trust facts. Returns a refusal reason, or `null`
 * when every fact holds:
 *   - same-repo PR (`isCrossRepository === false`) — fork PRs refused;
 *   - base branch is exactly `main`;
 *   - author login is on the (non-empty) `mergeAuthors` allow-list;
 *   - a backlog task matching the id derived from the branch/title exists on
 *     `origin/main` OR is added by the PR's own diff (the repo convention is
 *     that a task file is created and completed in the same PR).
 */
export async function evaluatePrTrust(args: {
  snapshot: PrSnapshot;
  mergeAuthors: string[];
  repoRoot: string;
  runner: Runner;
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
      'no spec.governance.mergeAuthors allow-list is configured in the verified main checkout ' +
      '.ai-sdlc/agent-role.yaml — refusing (fail-closed; an empty list trusts nobody)'
    );
  }
  const author = pr.authorLogin.toLowerCase();
  if (!mergeAuthors.some((a) => a.toLowerCase() === author)) {
    return `PR author "${pr.authorLogin}" is not on the spec.governance.mergeAuthors allow-list`;
  }
  const derived = deriveTaskId(pr.headRefName, pr.title);
  if (derived.conflict) return `ambiguous task id: ${derived.conflict}`;
  if (!derived.taskId) {
    return (
      `no backlog task id could be derived from head branch "${pr.headRefName}" ` +
      '(expected ai-sdlc/<id>-...) or the PR title (trailing "(<ID>)")'
    );
  }
  const inPr = pr.files.some(
    (f) =>
      f.changeType?.toUpperCase() !== 'DELETED' && isBacklogTaskFileFor(derived.taskId!, f.path),
  );
  if (!inPr && !(await taskFileOnOriginMain(derived.taskId, args.repoRoot, args.runner))) {
    return (
      `no backlog task file for "${derived.taskId}" exists on origin/main or in this PR's own ` +
      'diff (backlog/tasks or backlog/completed) — if it was merged recently, run ' +
      '"git fetch origin main" in the main checkout first'
    );
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
  /**
   * The VERIFIED main checkout (see `resolveTrustedMainRoot`) to read
   * `.ai-sdlc/agent-role.yaml` from. `null` = none could be established →
   * refuse (fail closed); `rootRefusal` then carries the reason.
   */
  repoRoot: string | null;
  rootRefusal?: string;
  /** This package's root, used to locate the CJS governance resolver. */
  pkgRoot: string;
  runner: Runner;
  cwd?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  dryRun?: boolean;
  /** Injection seam for hermetic tests — bypasses filesystem policy read. */
  loadPolicy?: (repoRoot: string, pkgRoot: string) => GovernancePolicy;
  /** Injection seam for hermetic tests — bypasses the allow-list read. */
  loadMergeAuthors?: (repoRoot: string, pkgRoot: string) => string[];
}

export interface RunMergeIfEligibleResult {
  prNumber: number;
  policy: GovernancePolicy;
  eligibility: MergeEligibilityResult;
  merged: boolean;
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
 *   2. policy `allowMerge` and caller `sourceKind` (no `gh` calls spent on a refusal);
 *   3. ONE `gh pr view` read (head commit, merge state, fork/author/base/title/files)
 *      then the trust facts (`evaluatePrTrust`);
 *   4. the required-checks (or check-run fallback) fetch;
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
  const repoRoot = opts.repoRoot;
  const policy =
    opts.loadPolicy?.(repoRoot, opts.pkgRoot) ??
    resolveRepoGovernancePolicy(repoRoot, opts.pkgRoot);

  // Policy gate, then the caller-supplied trust boundary: both can refuse
  // before any network call is spent.
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

  const mergeAuthors =
    opts.loadMergeAuthors?.(repoRoot, opts.pkgRoot) ??
    resolveRepoMergeAuthors(repoRoot, opts.pkgRoot);
  const trustRefusal = await evaluatePrTrust({
    snapshot,
    mergeAuthors,
    repoRoot,
    runner: opts.runner,
  });
  if (trustRefusal) return refuse(trustRefusal);

  const requiredResult = await fetchRequiredChecks(
    opts.prNumber,
    opts.repoSlug,
    opts.runner,
    opts.cwd,
  );

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
