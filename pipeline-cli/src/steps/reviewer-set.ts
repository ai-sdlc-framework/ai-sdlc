/**
 * Reviewer set resolver (AISDLC-617).
 *
 * Resolves whether a run should fan out the DEFAULT three reviewers
 * (code-reviewer, test-reviewer, security-reviewer) or the OPT-IN merged
 * two-reviewer set (correctness-reviewer, security-reviewer).
 *
 * ## AISDLC-722 (DEC-0055): the per-PR default is diff-derived
 *
 * `selectReviewerSet()` (the per-PR entry point used by the headless runner,
 * `07-build-review-prompts`) now picks the TWO-reviewer set by default when the
 * diff touches no trust-chain path, and the three-reviewer set otherwise. The
 * trust-chain path list and the classifier live in ONE module
 * (`attestation-core/review-scope-core.mjs`, shared with AISDLC-723's
 * correctness-only narrowing) that the CI verifier imports too, so the
 * verifier re-derives the same set from the same diff. A repository
 * requires three always with `reviewerSet: three` (env `AI_SDLC_REVIEWER_SET=three`
 * or the base-branch config). The legacy `code-test-merged` value now means the
 * default (diff-derived), because the classifier already picks two when safe.
 *
 * ## Config-only resolver (legacy, unchanged)
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
import {
  classifyReviewScope,
  isPathMissingGitError,
  parseSecurityReviewAlways,
  requiredReviewerKind,
  reviewerSetKindFor,
  type ReviewScopeClassification,
} from '../../attestation-core/review-scope-core.mjs';
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

/** The diff classifier's verdict for the per-PR default (AISDLC-722). */
export interface ReviewerSetClassification {
  set: 'two' | 'three';
  reviewers: ReviewerType[];
  /** `no-trust-chain-path` for two; otherwise why three was required. */
  reason: string;
  /** Trust-chain paths that forced the three-reviewer set. */
  triggeringPaths: string[];
}

/**
 * Derive the reviewer set from a diff (AISDLC-722, DEC-0055): three when the diff touches
 * a trust-chain path, the repository requires three, or the diff could not be read; two
 * otherwise. AISDLC-723's {@link reduceForReviewScope} may narrow a two further.
 * `changedPaths` is `null` when the diff could not be read (fails closed to three).
 */
export function classifyReviewerSet(input: {
  changedPaths: readonly string[] | null | undefined;
  requireThree?: boolean;
}): ReviewerSetClassification {
  const k = requiredReviewerKind(input.changedPaths, { requireThree: input.requireThree === true });
  if (k.kind === 'three') {
    return {
      set: 'three',
      reviewers: [...THREE_REVIEWER_SET],
      reason: k.reason,
      triggeringPaths: k.triggeringPaths,
    };
  }
  return {
    set: 'two',
    reviewers: [...CODE_TEST_MERGED_REVIEWER_SET],
    reason: 'no-trust-chain-path',
    triggeringPaths: [],
  };
}

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

/**
 * Derive the reviewer set for a worktree straight from git (AISDLC-722), for callers with no
 * in-process diff: the `/ai-sdlc execute` and orchestrator-tick skill bodies (via
 * `cli-attestation reviewer-set`). Same classifier and the same trusted config resolution
 * as {@link selectReviewerSet}; an unreadable diff fails closed to three.
 */
export function deriveReviewerSetFromGit(opts: {
  repoRoot: string;
  baseRef?: string;
  headRef?: string;
  env?: Record<string, string | undefined>;
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}): ReviewerSetClassification {
  const baseRef = opts.baseRef ?? 'origin/main';
  let changedPaths: string[] | null;
  try {
    changedPaths = execFileSync(
      'git',
      ['diff', '--name-only', '-z', '--no-renames', `${baseRef}...${opts.headRef ?? 'HEAD'}`],
      { cwd: opts.repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    )
      .split('\0')
      .filter(Boolean);
  } catch {
    changedPaths = null;
  }
  return classifyReviewerSet({
    changedPaths,
    requireThree:
      explicitReviewerSetMode({
        workDir: opts.repoRoot,
        baseRef,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.readBaseConfig ? { readBaseConfig: opts.readBaseConfig } : {}),
      }) === 'three',
  });
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
  /**
   * AISDLC-722: the diff classifier's verdict (set, reason, trust-chain paths that
   * forced the full set). Recorded in the attestation and logged at selection time.
   */
  classifier: ReviewerSetClassification;
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
  /** True when git reported any binary file in the diff (numstat `-\t-` row). */
  binaryDiff?: boolean;
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
  // AISDLC-722: the default set is derived from the diff. Only an explicit `three`
  // (env or base-branch config) requires three always; the legacy `code-test-merged`
  // value and "nothing configured" both mean "diff-derived".
  const classifier = classifyReviewerSet({
    changedPaths: opts.diffUnavailable === true ? null : opts.changedFiles,
    requireThree: explicitReviewerSetMode(opts) === 'three',
  });
  const mode: ReviewerSetMode = classifier.set === 'two' ? 'code-test-merged' : 'three';
  const base = (source: ReviewerSetSource, decidedBy: string): ReviewerSetSelection => ({
    reviewers: setOf(mode),
    mode,
    source,
    decidedBy,
    classifier,
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
  // `!(n <= 1)` so a NaN iteration counts as a re-run and never relaxes review.
  if (!((opts.iteration ?? 1) <= 1)) return vetoed('veto:iteration');
  if (opts.changedFiles.length === 0) return vetoed('veto:no-changed-files');
  if (opts.diffUnavailable === true || opts.diff.trim() === '') {
    return vetoed('veto:diff-unavailable');
  }
  if (opts.binaryDiff === true || diffHasBinaryHunk(opts.diff)) return vetoed('veto:binary-diff');
  if (scan.unparseable) return vetoed('veto:unparseable-path');
  if (risk.touchesAuth) return vetoed('veto:path-auth');
  if (risk.touchesLockfiles) return vetoed('veto:path-lockfile');
  if (risk.touchesCi) return vetoed('veto:path-ci');
  if (governance !== undefined) return vetoed('veto:path-governance');
  // AISDLC-722: a trust-chain diff never gets the two-reviewer set, whatever the judgment says.
  if (classifier.set === 'three') return vetoed(`veto:classifier-${classifier.reason}`);

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
      classifier,
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

// ── Diff-scope reduction (AISDLC-723, DEC-0055) ──────────────────────────────────────

export interface ReviewScopeReduction {
  reviewers: ReviewerType[];
  classification: ReviewScopeClassification;
  /** True when `securityReview: always` on the base branch kept the full set. */
  securityAlways: boolean;
  /** Why the classification came out as it did (path or rule). */
  reason: string;
}

/** `''` when absent at `baseRef`, the text when present, `null` on any other git error. */
function readBaseConfigFailClosed(workDir: string, baseRef: string): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:.ai-sdlc/review-config.yaml`], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return isPathMissingGitError(err) ? '' : null;
  }
}

export interface ReduceForReviewScopeOpts {
  /** The set chosen by `selectReviewerSet` / the resolver. */
  reviewers: readonly ReviewerType[];
  changedFiles: readonly string[];
  /** True when the diff or file list could not be read completely; never reduces. */
  diffUnavailable?: boolean;
  /** True when the repository requires three reviewers always (`reviewerSet: three`); never reduces. */
  requireThree?: boolean;
  workDir?: string;
  baseRef?: string;
  /** Test injection; same contract as {@link ResolveReviewerSetOpts.readBaseConfig}. */
  readBaseConfig?: (workDir: string, baseRef: string) => string | null;
}

/** The only reviewer a test-only or docs-adjacent diff runs. */
export const CORRECTNESS_ONLY_REVIEWER_SET: readonly ReviewerType[] = [
  'correctness-reviewer',
] as const;

/**
 * Narrow the reviewer set to the correctness reviewer alone when the diff is
 * test-only or docs-adjacent (path-based), no trust-chain / workflow / hook /
 * security-test path is present, and the base branch does not set
 * `securityReview: always`. Everything else returns `reviewers` unchanged.
 *
 * The classifier is the shared `review-scope-core.mjs`, which the CI verifier
 * re-runs against the diff: a set this function narrows is only accepted by the
 * verifier if the re-derived classification agrees. The config is read from the
 * base ref, never the PR worktree (see the module-level trust boundary).
 */
export function reduceForReviewScope(opts: ReduceForReviewScopeOpts): ReviewScopeReduction {
  const unchanged = (
    classification: ReviewScopeClassification,
    reason: string,
    securityAlways = false,
  ): ReviewScopeReduction => ({
    reviewers: [...opts.reviewers],
    classification,
    securityAlways,
    reason,
  });
  if (opts.diffUnavailable === true) return unchanged('full', 'diff unavailable');
  const scope = classifyReviewScope(opts.changedFiles);
  if (opts.requireThree === true) return unchanged(scope.classification, 'config:require-three');
  const workDir = opts.workDir ?? process.cwd();
  const baseRef = opts.baseRef ?? 'origin/main';
  // Fail closed: only a definitely-absent config reads as "no securityReview: always".
  const baseConfig = opts.readBaseConfig
    ? (opts.readBaseConfig(workDir, baseRef) ?? '')
    : readBaseConfigFailClosed(workDir, baseRef);
  const securityAlways = baseConfig === null ? true : parseSecurityReviewAlways(baseConfig);
  if (reviewerSetKindFor(scope.classification, { securityAlways }) === 'full') {
    return unchanged(scope.classification, scope.reason, securityAlways);
  }
  return {
    reviewers: [...CORRECTNESS_ONLY_REVIEWER_SET],
    classification: scope.classification,
    securityAlways,
    reason: scope.reason,
  };
}
