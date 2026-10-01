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
import {
  REVIEWER_SET_MERGED,
  evaluateJudgment,
  reviewerSetDefinition,
  type EvaluateJudgmentContext,
  type JudgmentMode,
} from '@ai-sdlc/reference';
import type { ReviewerType } from '../types.js';
import { classifyPathRisk } from '../classifier/classifier.js';
import {
  diffHasBinaryHunk,
  governancePathMatch,
  judgmentLayerActive,
  scanReviewPaths,
  selectionLogRecord,
  withCapturedRecord,
  writeSelectionRecord,
} from './review-judgment-support.js';

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

// ── Per-PR selection (review.reviewer-set judgment) ──────────────────────────────────

/** Where the selected set came from. */
export type ReviewerSetSource = 'judgment' | 'config';

export interface ReviewerSetSelection {
  reviewers: ReviewerType[];
  mode: ReviewerSetMode;
  source: ReviewerSetSource;
  /** The veto, pin or signal that decided the outcome (also written to the judgment log). */
  decidedBy: string;
}

export interface SelectReviewerSetOpts extends ResolveReviewerSetOpts {
  /** Kind of the work item; only `'backlog'` can ever select the merged set. */
  sourceKind?: string;
  taskId?: string;
  /** Paths changed by the diff. */
  changedFiles: readonly string[];
  /** Unified diff text. */
  diff: string;
  /**
   * True when the diff or the file list could not be read completely (a failed or
   * truncated git call). The judgment then never relaxes review: it must not judge
   * file names alone.
   */
  diffUnavailable?: boolean;
  /** Review iteration (1 = first pass). A re-run never relaxes review. */
  iteration?: number;
  /** Ready judgment context; omit (or leave the layer unconfigured) to keep today's behaviour. */
  judgment?: EvaluateJudgmentContext;
}

/**
 * The mode an operator pinned through env or base-branch config, or `null` when
 * neither names one. Mirrors the resolver's precedence and sources.
 */
export function explicitReviewerSetMode(opts: ResolveReviewerSetOpts = {}): ReviewerSetMode | null {
  const env = opts.env ?? process.env;
  const envValue = env.AI_SDLC_REVIEWER_SET;
  if (envValue === 'code-test-merged' || envValue === 'three') return envValue;
  const raw = (opts.readBaseConfig ?? readReviewConfigFromBaseRef)(
    opts.workDir ?? process.cwd(),
    opts.baseRef ?? 'origin/main',
  );
  return raw ? parseReviewerSetModeYaml(raw) : null;
}

/** Enforce the floors on any set: security always present, never fewer than the merged set. */
export function applyReviewerSetFloors(set: readonly ReviewerType[]): ReviewerType[] {
  const out = [...new Set(set)];
  if (!out.includes('security-reviewer')) out.push('security-reviewer');
  return out.length < CODE_TEST_MERGED_REVIEWER_SET.length ? [...THREE_REVIEWER_SET] : out;
}

const setOf = (mode: ReviewerSetMode): ReviewerType[] =>
  applyReviewerSetFloors(
    mode === 'code-test-merged' ? CODE_TEST_MERGED_REVIEWER_SET : THREE_REVIEWER_SET,
  );

/**
 * Choose the reviewer set for one PR.
 *
 * The merged two-reviewer set comes from the judgment only when ALL hold: the
 * judgment's effective mode is `enforce` (the runtime requires a corpus promotion
 * record), `sourceKind` is `backlog`, the path classifier raised no auth, lockfile or
 * CI match, and the judgment returned `act`. Anything else returns exactly what
 * `resolveReviewerSetMode` returns, and an explicit mode from env or base-branch
 * config always applies as it does without the judgment.
 */
export async function selectReviewerSet(
  opts: SelectReviewerSetOpts,
): Promise<ReviewerSetSelection> {
  const mode = resolveReviewerSetMode(opts);
  const base = (source: ReviewerSetSource, decidedBy: string): ReviewerSetSelection => ({
    reviewers: setOf(mode),
    mode,
    source,
    decidedBy,
  });
  const ctx = opts.judgment;
  if (!ctx || !judgmentLayerActive(ctx)) return base('config', 'config:layer-disabled');

  const pinned = explicitReviewerSetMode(opts);
  // The selection record uses an id with no registered definition on purpose: it is an
  // audit line, not an evaluation, so `cli-judgment replay` and `eval` skip it.
  const log = (
    sel: ReviewerSetSelection,
    inputs: Record<string, unknown>,
    effective: JudgmentMode,
  ) =>
    writeSelectionRecord(
      ctx,
      selectionLogRecord(
        'review.reviewer-set.selection',
        { ...ctx, ...(opts.taskId ? { taskId: opts.taskId } : {}) },
        {
          set: sel.mode,
          reviewers: sel.reviewers,
          source: sel.source,
          decidedBy: sel.decidedBy,
          inputs,
        },
        { set: mode },
        effective,
      ),
    );

  const scan = scanReviewPaths(opts.changedFiles, opts.diff);
  const risk = classifyPathRisk(scan.paths);
  const governance = governancePathMatch(scan.paths);
  const inputs = {
    sourceKind: opts.sourceKind ?? null,
    changedFiles: opts.changedFiles.length,
    pathAuth: risk.touchesAuth,
    pathLockfile: risk.touchesLockfiles,
    pathCi: risk.touchesCi,
    pathGovernance: governance !== undefined,
    pinned,
  };
  const vetoed = async (decidedBy: string): Promise<ReviewerSetSelection> => {
    const sel = base('config', decidedBy);
    await log(sel, inputs, 'off');
    return sel;
  };

  if (pinned !== null) return vetoed(`config:explicit-${pinned}`);
  if (opts.sourceKind !== 'backlog') return vetoed('veto:source-kind');
  if ((opts.iteration ?? 1) > 1) return vetoed('veto:iteration');
  if (opts.changedFiles.length === 0) return vetoed('veto:no-changed-files');
  if (opts.diffUnavailable === true || opts.diff.trim() === '') {
    return vetoed('veto:diff-unavailable');
  }
  if (diffHasBinaryHunk(opts.diff)) return vetoed('veto:binary-diff');
  if (scan.unparseable) return vetoed('veto:unparseable-path');
  if (risk.touchesAuth) return vetoed('veto:path-auth');
  if (risk.touchesLockfiles) return vetoed('veto:path-lockfile');
  if (risk.touchesCi) return vetoed('veto:path-ci');
  if (governance !== undefined) return vetoed('veto:path-governance');

  const { value: outcome, record } = await withCapturedRecord(
    { ...ctx, sourceKind: 'backlog', ...(opts.taskId ? { taskId: opts.taskId } : {}) },
    (c) =>
      evaluateJudgment(
        reviewerSetDefinition,
        { changedFiles: [...opts.changedFiles], diff: opts.diff },
        { ...c, incumbent: { set: mode } },
      ),
  );
  const effective: JudgmentMode = record?.mode ?? 'off';
  if (
    outcome.kind === 'act' &&
    effective === 'enforce' &&
    outcome.decision.set === REVIEWER_SET_MERGED
  ) {
    const sel: ReviewerSetSelection = {
      reviewers: setOf('code-test-merged'),
      mode: 'code-test-merged',
      source: 'judgment',
      decidedBy: 'judgment:all-signals-below-threshold',
    };
    await log(sel, { ...inputs, signals: outcome.decision.signals, defaultMode: mode }, effective);
    return sel;
  }
  const why =
    effective !== 'enforce'
      ? `judgment:not-enforced:${record?.downgradeReason ?? effective}`
      : outcome.kind === 'abstain'
        ? `judgment:${outcome.reason}`
        : `judgment:${outcome.kind}`;
  const sel = base('config', why);
  await log(sel, inputs, effective);
  return sel;
}
