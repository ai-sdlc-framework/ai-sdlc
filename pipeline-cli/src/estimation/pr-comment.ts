/**
 * PR estimate comment renderer — RFC-0016 Phase 5 (AISDLC-283).
 *
 * Renders the `<!-- ai-sdlc:estimate -->` bot comment body (RFC §9a / Q7
 * resolution). This is the single source of truth for comment composition —
 * the GitHub Actions workflow (`.github/workflows/estimate-pr-comment.yml`)
 * calls `cli-estimate render-pr-comment` which delegates here.
 *
 * ## Idempotent marker pattern (AISDLC-142)
 *
 * The comment body ALWAYS starts with:
 *   `<!-- ai-sdlc:estimate -->`
 *
 * The workflow scans the PR's existing comments for this marker and either:
 *  - Edits the existing comment (single comment per PR — AC #5)
 *  - Posts a fresh comment when none exists
 *
 * ## Comment payload (RFC §9a)
 *
 * ```markdown
 * <!-- ai-sdlc:estimate -->
 * **Estimated:** M (calibrated, n=23, bias=+15%)
 * **Class:** feature
 * **Stage A signals:** 6 of 6 agreed (file scope, dep depth, ...)
 * **Variance across runs:** 0 buckets (single estimate, n=1)
 *
 * *Last updated: <isoTimestamp>*
 * ```
 *
 * ## State token
 *
 * The Q6 state token is rendered by `formatStateToken()` from `./bias.ts` —
 * the same function used by `cli-estimates show <class>` CLI, the dashboard,
 * and Slack. Single source of truth, no surface-specific parsing.
 *
 * @module estimation/pr-comment
 */

import type { Bucket, StageAResult, TaskClass } from './types.js';
import { formatStateToken } from './bias.js';

/** Idempotent marker injected at the top of every estimate comment. */
export const ESTIMATE_COMMENT_MARKER = '<!-- ai-sdlc:estimate -->' as const;

/**
 * Input to `renderEstimateComment()`.
 */
export interface RenderEstimateCommentOpts {
  /** Stage A result — provides signals, candidate bucket, class, confidence. */
  stageAResult: StageAResult;
  /**
   * Number of calibration sample pairs for the task class. Determines the
   * Q6 state token (uncalibrated / warming / calibrated).
   */
  calibrationN: number;
  /**
   * Signed mean bucket miss for the task class (positive = overestimate).
   * `null` when n < 5 or no calibration data.
   */
  meanBucketMiss?: number | null;
  /**
   * RFC §8.4 ensemble variance across same-hash log rows. When ≥ 2, the
   * state token gains the `; high-variance` qualifier.
   * Defaults to 0 (single-run estimate).
   */
  estimateVariance?: number;
  /**
   * Override for the timestamp shown in "Last updated: …". Tests inject a
   * frozen timestamp; production uses `new Date().toISOString()`.
   */
  now?: () => Date;
  /**
   * Actual bucket recorded in calibration.jsonl (when the PR has been
   * merged and the actuals collector has run). When present, a "Actual:"
   * line is appended.
   */
  actualBucket?: Bucket;
}

/**
 * Result of `renderEstimateComment()`.
 */
export interface RenderEstimateCommentResult {
  /** Full comment body including the idempotent marker. */
  body: string;
  /** Whether the marker is present (should always be `true`). */
  hasMarker: boolean;
  /** The formatted state token (used by surfaces other than the comment body). */
  stateToken: string;
}

/**
 * Render the RFC §9a bot PR comment body.
 *
 * The returned `body` is ready to be posted to GitHub — the caller does not
 * need to add the marker (it is embedded at the top of the body).
 *
 * This is the single source of truth for comment composition. The GitHub
 * Actions workflow, the CLI `render-pr-comment` subcommand, and any future
 * surface (dashboard "preview PR comment" action, Slack bot reply) all call
 * this function.
 */
export function renderEstimateComment(
  opts: RenderEstimateCommentOpts,
): RenderEstimateCommentResult {
  const now = (opts.now ?? ((): Date => new Date()))();
  const ts = now.toISOString();

  const stateToken = formatStateToken(
    opts.calibrationN,
    opts.meanBucketMiss,
    opts.estimateVariance,
  );

  const bucketDisplay = opts.stageAResult.candidateRange
    ? `${opts.stageAResult.candidateRange.low}-${opts.stageAResult.candidateRange.high}`
    : opts.stageAResult.candidateBucket;

  const signalSummary = buildSignalSummary(opts.stageAResult);
  const varianceLine = buildVarianceLine(opts.estimateVariance ?? 0);

  const lines: string[] = [
    ESTIMATE_COMMENT_MARKER,
    `**Estimated:** ${bucketDisplay} ${stateToken}`,
    `**Class:** ${opts.stageAResult.taskClass}`,
    `**Stage A signals:** ${signalSummary}`,
    `**Variance across runs:** ${varianceLine}`,
  ];

  if (opts.actualBucket !== undefined) {
    lines.push(`**Actual:** ${opts.actualBucket}`);
  }

  lines.push('');
  lines.push(`*Last updated: ${ts}*`);

  const body = lines.join('\n');

  return {
    body,
    hasMarker: body.includes(ESTIMATE_COMMENT_MARKER),
    stateToken,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the "Stage A signals: N of M agreed (…)" line per RFC §9a.
 */
function buildSignalSummary(stageA: StageAResult): string {
  const votingSignals = stageA.signals.filter(
    (s) => s.result.kind === 'bucket' || s.result.kind === 'range',
  );
  const totalSignals = stageA.signals.filter((s) => s.result.kind !== 'unknown').length;
  const signalNames = votingSignals.map((s) => s.name).join(', ');

  if (votingSignals.length === 0) {
    return `0 of ${stageA.signals.length} resolved (cold-start)`;
  }

  const confidence =
    stageA.confidence === 'high'
      ? 'all agreed'
      : stageA.confidence === 'medium'
        ? 'adjacent split'
        : 'non-adjacent split';

  const summary = `${votingSignals.length} of ${totalSignals} resolved (${confidence})`;
  return signalNames ? `${summary}: ${signalNames}` : summary;
}

/**
 * Build the "Variance across runs: N buckets" line per RFC §9a.
 */
function buildVarianceLine(estimateVariance: number): string {
  if (estimateVariance === 0) {
    return '0 buckets (single estimate, n=1)';
  }
  const qualifier = estimateVariance >= 2 ? ' ⚠️ high-variance' : '';
  return `${estimateVariance} bucket${estimateVariance === 1 ? '' : 's'}${qualifier}`;
}

/**
 * Check whether a comment body already contains the idempotent marker.
 * Used by the workflow to detect existing estimate comments without
 * re-parsing the full body.
 */
export function hasEstimateMarker(body: string): boolean {
  return body.includes(ESTIMATE_COMMENT_MARKER);
}

/**
 * Render a summary of the task class's calibration state for use in
 * dashboard / Slack surfaces. Returns just the state token string — callers
 * embed it in their own templates.
 */
export function renderCalibrationStateToken(
  taskClass: TaskClass,
  calibrationN: number,
  meanBucketMiss: number | null,
  estimateVariance?: number,
): string {
  return formatStateToken(calibrationN, meanBucketMiss, estimateVariance);
}
