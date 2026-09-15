/**
 * Reviewer set resolver (AISDLC-617).
 *
 * Resolves whether a run should fan out the DEFAULT three reviewers
 * (code-reviewer, test-reviewer, security-reviewer) or the OPT-IN merged
 * two-reviewer set (correctness-reviewer, security-reviewer).
 *
 * ## Default is unchanged
 *
 * `resolveReviewerSetMode()` returns `'three'` unless EITHER:
 *   - the `AI_SDLC_REVIEWER_SET` env var is explicitly `'code-test-merged'`, OR
 *   - `.ai-sdlc/review-config.yaml` AS COMMITTED ON `origin/main` sets
 *     `reviewerSet: code-test-merged`
 *
 * This task (AISDLC-617) does NOT flip the default — it only wires the
 * opt-in path so the merged reviewer can be A/B'd against the AISDLC-616
 * findings ledger before any permanent default change.
 *
 * ## Trust boundary — config is read from `origin/main`, NOT the PR worktree
 * (security review fix, round 2)
 *
 * `.ai-sdlc/review-config.yaml` MUST be resolved from the base branch
 * (`origin/main`) via `git show origin/main:.ai-sdlc/review-config.yaml`,
 * never from the PR-controlled worktree checkout (`opts.workDir`'s working
 * tree). Reading it from the worktree would let an untrusted PR author
 * commit `reviewerSet: code-test-merged` in their OWN PR diff to opt their
 * own diff into the shallower single-pass correctness review — a
 * self-selection hole even though it's bounded (security-reviewer is always
 * preserved in both sets). Resolving from `origin/main` means changing
 * review depth requires a MERGED, ALREADY-REVIEWED change to main — the
 * same trust model as every other `.ai-sdlc/*.yaml` pipeline config file
 * (see `.ai-sdlc/review-policy.md`'s own "Trusted Input Sources" list).
 *
 * Fails safe to `'three'` when `origin/main` has no such file, when the ref
 * doesn't exist locally (e.g. never fetched), or when `git show` errors for
 * any other reason — a config-resolution failure must never silently
 * broaden or narrow review scope.
 *
 * Parsing intentionally avoids pulling in `js-yaml` for a single flat
 * field — mirrors the line-based reader in `pipeline-cli/src/dor/dor-config.ts`.
 *
 * @module steps/reviewer-set
 */

import { execFileSync } from 'node:child_process';
import type { ReviewerType } from '../types.js';

export type ReviewerSetMode = 'three' | 'code-test-merged';

/** The default three-reviewer set — UNCHANGED by AISDLC-617. */
export const THREE_REVIEWER_SET: readonly ReviewerType[] = [
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
] as const;

/** The opt-in merged two-reviewer set (AISDLC-617). Security stays separate. */
export const CODE_TEST_MERGED_REVIEWER_SET: readonly ReviewerType[] = [
  'correctness-reviewer',
  'security-reviewer',
] as const;

export interface ResolveReviewerSetOpts {
  /** Project root (git repo / worktree root). Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override env for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Base ref the trusted `.ai-sdlc/review-config.yaml` is read from.
   * Defaults to `'origin/main'`. Only overridden by non-main-based repos /
   * tests — NEVER read the PR worktree's own working-tree copy of the file.
   */
  baseRef?: string;
  /**
   * Override the base-branch config reader (test injection). Defaults to
   * {@link readReviewConfigFromBaseRef} (real `git show <baseRef>:<path>`
   * against `workDir`). Must return `null` — never throw — when the file
   * doesn't exist on the base ref or the read fails for any reason; the
   * caller treats `null` as "no committed config, use the default".
   */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}

/**
 * Read `.ai-sdlc/review-config.yaml` AS COMMITTED on `baseRef` (default
 * `origin/main`) via `git show <baseRef>:.ai-sdlc/review-config.yaml`.
 *
 * Deliberately does NOT read the working tree — see the module-level
 * "Trust boundary" doc comment. Returns `null` (never throws) when the file
 * doesn't exist on that ref, the ref itself doesn't exist locally, or `git`
 * is unavailable — every failure mode falls back to the default reviewer
 * set, never to a broader/narrower one.
 */
export function readReviewConfigFromBaseRef(workDir: string, baseRef: string): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:.ai-sdlc/review-config.yaml`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the effective `ReviewerSetMode`. Precedence (first match wins):
 *
 *   1. `AI_SDLC_REVIEWER_SET` env var (`'three'` | `'code-test-merged'`) —
 *      operator/CI-controlled, makes the flag A/B-able per-invocation
 *      without touching config files.
 *   2. `.ai-sdlc/review-config.yaml`'s `reviewerSet:` field **as committed
 *      on `baseRef` (default `origin/main`)** — NEVER the PR worktree's own
 *      working-tree copy (see the module-level "Trust boundary" doc). A PR
 *      author cannot opt their own diff into the shallower reviewer set by
 *      editing this file in their own branch; the change must land on main
 *      first (through the existing, unweakened review) to take effect.
 *   3. Default: `'three'`.
 */
export function resolveReviewerSetMode(opts: ResolveReviewerSetOpts = {}): ReviewerSetMode {
  const env = opts.env ?? process.env;
  const envValue = env.AI_SDLC_REVIEWER_SET;
  if (envValue === 'code-test-merged' || envValue === 'three') return envValue;

  const workDir = opts.workDir ?? process.cwd();
  const baseRef = opts.baseRef ?? 'origin/main';
  const readBaseConfig = opts.readBaseConfig ?? readReviewConfigFromBaseRef;

  const raw = readBaseConfig(workDir, baseRef);
  if (raw) {
    const mode = parseReviewerSetModeYaml(raw);
    if (mode) return mode;
  }

  return 'three';
}

/**
 * Parse a `reviewerSet:` scalar field out of a review-config YAML string.
 * Public so tests can drive the parser without touching the filesystem.
 * Returns `null` when no valid field is found (caller falls back to default).
 */
export function parseReviewerSetModeYaml(yaml: string): ReviewerSetMode | null {
  const match = yaml.match(/^\s*reviewerSet:\s*['"]?(three|code-test-merged)['"]?\s*$/m);
  if (!match) return null;
  return match[1] as ReviewerSetMode;
}

/** Resolve the reviewer set mode straight to the concrete `ReviewerType[]`. */
export function resolveReviewerSet(opts: ResolveReviewerSetOpts = {}): ReviewerType[] {
  const mode = resolveReviewerSetMode(opts);
  return mode === 'code-test-merged' ? [...CODE_TEST_MERGED_REVIEWER_SET] : [...THREE_REVIEWER_SET];
}
