/**
 * Filter — Open-PR-exists detection (AISDLC-361).
 *
 * Catches tasks whose canonical branch ALREADY has an open GitHub PR so the
 * orchestrator never re-admits and re-dispatches a task that is stuck in
 * review or blocked mid-pipeline. Without this filter, every tick that
 * evaluates a task with a stuck open PR reaches Step 3 (worktree-create),
 * where `detectDraftPrForBranch` also finds the PR and aborts — wasting
 * the tick slot. With `--max-concurrent 2` and 2 stuck PRs, the orchestrator
 * deadlocks (no slots available for new dispatch).
 *
 * Why BEFORE AlreadyInFlight?
 * ============================
 * `AlreadyInFlight` uses a WILDCARD branch pattern (`ai-sdlc/<task-id>-*`)
 * and is designed to catch mid-dispatch duplicates in the CURRENT process.
 * `OpenPullRequestExists` uses the EXACT canonical branch name and targets
 * PRs that exist outside the in-flight map (opened in a prior run, opened
 * by a different process, or stuck with no worktree sentinel). Running it
 * first ensures the more general "any open PR at all" check short-circuits
 * before the narrower duplicate-dispatch detection.
 *
 * Branch name computation
 * =======================
 * Uses `readBranchPattern` + `slugify` from step 02 directly (sync path)
 * rather than the async `computeBranchName` wrapper. The filter chain is
 * synchronous so the async wrapper is not usable here. The result is
 * identical: `<pattern>.replace('{issueIdLower}', id).replace('{slug}', slug)`.
 *
 * Cache
 * =====
 * The tick loop passes a `prListCache: Map<string, OpenPREntry[]>` so the
 * `gh pr list --head <branch>` call is made at most ONCE per branch per tick
 * (AC #2). Tests inject the cache pre-populated to stay hermetic.
 *
 * Filter position: BEFORE AlreadyInFlight — first filter in the chain.
 *
 * @module orchestrator/filters/open-pull-request-exists
 */

import { execSync } from 'node:child_process';
import { slugify, readBranchPattern, FALLBACK_SLUG } from '../../steps/02-compute-branch.js';
import type { FilterResult } from './types.js';

/** Single entry returned by `gh pr list` for an open PR. */
export interface OpenPREntry {
  number: number;
  isDraft: boolean;
  url?: string;
}

/** Structured detail carried in the `OrchestratorBlockedByOpenPullRequest` event. */
export interface OpenPullRequestExistsDetail {
  kind: 'open-pull-request-exists';
  /** PR number of the existing open PR. */
  prNumber: number;
  /** Whether the existing PR is a draft. */
  isDraft: boolean;
  /** The canonical branch name the PR is open for. */
  branchName: string;
  /**
   * PR URL — populated when `gh pr list` returns a `url` field so operators
   * can click through directly from the filter trace log. Absent when the
   * injected `listOpenPRsByBranch` stub does not include it.
   */
  prUrl?: string;
}

export interface CheckOpenPullRequestExistsOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Task title — used to compute the branch slug via `slugify()`. When
   * undefined the filter falls back to using the lowercased task ID as the
   * slug (degrade-open: the branch may not match exactly, but this prevents
   * a missing-title from causing an unconditional admit).
   */
  taskTitle?: string;
  /**
   * Absolute path to the repo / worktree root used to resolve the
   * `.ai-sdlc/pipeline.yaml` branch pattern. Defaults to `process.cwd()`.
   */
  workDir?: string;
  /**
   * Tick-scoped cache: `Map<branchName, OpenPREntry[]>`. Shared across all
   * filter evaluations in one tick so each branch is queried at most once.
   * When the cache already has an entry for the branch the gh call is skipped.
   * Tests pre-populate this to drive the filter without network access.
   */
  prListCache?: Map<string, OpenPREntry[]>;
  /**
   * Injectable `gh pr list` runner — replaces the real `gh` call in tests.
   * Receives the exact branch head name; returns an array of `OpenPREntry`
   * objects or throws on error. When undefined the filter runs the real
   * `gh pr list --head <branch> --state open --json number,isDraft,url`.
   */
  listOpenPRsByBranch?: (branch: string) => OpenPREntry[];
}

/**
 * Check whether the candidate task's canonical branch already has an open PR.
 *
 * Returns `{ filter: 'OpenPullRequestExists', passed: false, reason, detail }`
 * when an open PR exists for the branch; returns `{ passed: true }` otherwise.
 *
 * Degrade-open on any `gh` error — the filter admits the candidate rather
 * than blocking dispatch on a transient network failure. The downstream
 * `AlreadyInFlight` wildcard check serves as a backstop.
 */
export function checkOpenPullRequestExists(opts: CheckOpenPullRequestExistsOpts): FilterResult {
  const taskIdLower = opts.taskId.toLowerCase();
  const workDir = opts.workDir ?? process.cwd();

  // --- Compute the canonical branch name (sync, mirrors step 02) ---
  // AISDLC-361 code-reviewer MAJOR: mirror step 02's FALLBACK_SLUG logic when
  // slugify returns empty (pure-punctuation or non-ASCII title). The filter
  // would otherwise check a different branch than the worktree-create step
  // → admits the task → Step 3 aborts on the open PR → the very deadlock
  // this filter was built to prevent.
  const pattern = readBranchPattern(workDir);
  const rawSlug = opts.taskTitle ? slugify(opts.taskTitle) : '';
  const slug = rawSlug !== '' ? rawSlug : pattern.includes('{slug}') ? FALLBACK_SLUG : taskIdLower;
  const branchName = pattern.replace(/\{issueIdLower\}/g, taskIdLower).replace(/\{slug\}/g, slug);

  // --- Cache lookup (AC #2: at most one gh call per branch per tick) ---
  const cache = opts.prListCache ?? new Map<string, OpenPREntry[]>();
  let openPRs: OpenPREntry[];

  if (cache.has(branchName)) {
    openPRs = cache.get(branchName)!;
  } else {
    try {
      openPRs = opts.listOpenPRsByBranch
        ? opts.listOpenPRsByBranch(branchName)
        : runGhPRListByBranch(branchName);
    } catch {
      // Degrade-open: gh not available or network error — skip rather than block.
      openPRs = [];
    }
    cache.set(branchName, openPRs);
  }

  if (openPRs.length === 0) {
    return { filter: 'OpenPullRequestExists', passed: true };
  }

  const pr = openPRs[0];
  const prState = pr.isDraft ? 'draft' : 'open';
  // AC #5 (filter trace UX): include the PR URL in the reason string so
  // operators can click through from the trace log directly.
  const urlClause = pr.url ? ` ${pr.url}` : '';
  const reason = `open PR #${pr.number}${urlClause} (${prState}) already exists for branch ${branchName}`;

  const detail: OpenPullRequestExistsDetail = {
    kind: 'open-pull-request-exists',
    prNumber: pr.number,
    isDraft: pr.isDraft,
    branchName,
    ...(pr.url !== undefined ? { prUrl: pr.url } : {}),
  };

  return {
    filter: 'OpenPullRequestExists',
    passed: false,
    reason,
    detail,
  };
}

/**
 * Run `gh pr list --head <branch> --state open --json number,isDraft,url`.
 * Returns the parsed entries or throws on non-zero exit / parse failure.
 */
function runGhPRListByBranch(branch: string): OpenPREntry[] {
  const stdout = execSync(
    `gh pr list --head ${JSON.stringify(branch)} --state open --json number,isDraft,url`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  if (stdout === '' || stdout === '[]') return [];
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is { number: number; isDraft: boolean; url?: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).number === 'number' &&
      typeof (entry as Record<string, unknown>).isDraft === 'boolean',
  );
}
