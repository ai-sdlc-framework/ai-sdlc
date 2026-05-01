/**
 * DoR two-stage staleness sweeper (RFC-0011 §13 Q6).
 *
 * Default behaviour: at 14 days of no author activity post a "this issue
 * is stale, will auto-close in 14 days" warning to the same channel(s)
 * as the original clarification (per Q5 dual-fanout). At 28 days,
 * auto-close with a configurable label so stale-DoR-closures are
 * queryable.
 *
 * The thresholds are configurable via `.ai-sdlc/dor-config.yaml`.
 *
 * This module is **decision-only**: given a list of needs-clarification
 * issues + their last-author-activity timestamps + the current config,
 * it returns the list of (issue, action) pairs the orchestration layer
 * should execute. Actually posting the warning + closing the issue is
 * the responsibility of the calling shim — same separation as the
 * comment loop.
 */

import { DOR_CONFIG_DEFAULTS, type DorConfigStaleness } from './dor-config.js';

export type StalenessAction = 'none' | 'warn' | 'close';

export interface StalenessCandidate {
  /** Issue identifier (e.g. 'AISDLC-92', 'gh#42'). */
  issueId: string;
  /** ISO-8601 timestamp of the last author activity (edit / comment). */
  lastAuthorActivityAt: string;
  /** Whether the warning comment has already been posted. Drives the warn → close transition. */
  warnedAt?: string;
}

export interface StalenessDecision {
  issueId: string;
  action: StalenessAction;
  /** Days of inactivity at decision time (rounded down). */
  daysInactive: number;
  /** Reason text — useful for the orchestration layer's log line. */
  reason?: string;
}

export interface DecideStalenessOpts {
  /** Override the current time. Defaults to `Date.now()`. */
  now?: Date;
  /** Override the staleness config. Defaults to `DOR_CONFIG_DEFAULTS.staleness`. */
  config?: DorConfigStaleness;
}

/**
 * Decide what to do with a single needs-clarification candidate.
 *
 * State machine:
 *   - daysInactive < warnAfterDays                 → 'none'
 *   - daysInactive ∈ [warnAfterDays, closeAfterDays) AND not warned → 'warn'
 *   - daysInactive ≥ closeAfterDays                → 'close'
 *   - warned-but-still-pre-close                   → 'none'
 *
 * The 'warn' edge transition is one-shot — once `warnedAt` is set, we
 * don't re-warn until the close threshold trips.
 */
export function decideStaleness(
  candidate: StalenessCandidate,
  opts: DecideStalenessOpts = {},
): StalenessDecision {
  const now = opts.now ?? new Date();
  const config = opts.config ?? DOR_CONFIG_DEFAULTS.staleness;

  const lastActivity = new Date(candidate.lastAuthorActivityAt);
  const daysInactive = Math.max(
    0,
    Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)),
  );

  if (daysInactive >= config.closeAfterDays) {
    return {
      issueId: candidate.issueId,
      action: 'close',
      daysInactive,
      reason: `Inactive for ${daysInactive} days (>= closeAfterDays=${config.closeAfterDays}).`,
    };
  }

  if (daysInactive >= config.warnAfterDays) {
    if (candidate.warnedAt) {
      return { issueId: candidate.issueId, action: 'none', daysInactive };
    }
    return {
      issueId: candidate.issueId,
      action: 'warn',
      daysInactive,
      reason: `Inactive for ${daysInactive} days (>= warnAfterDays=${config.warnAfterDays}).`,
    };
  }

  return { issueId: candidate.issueId, action: 'none', daysInactive };
}

/**
 * Run the decider across a batch of candidates. Returns one decision per
 * input. Order is preserved; the caller can filter on `action` to drive
 * the warn / close fanout.
 */
export function decideStalenessBatch(
  candidates: StalenessCandidate[],
  opts: DecideStalenessOpts = {},
): StalenessDecision[] {
  return candidates.map((c) => decideStaleness(c, opts));
}

/**
 * Render the staleness warning comment body. The warning is posted via
 * the comment loop's poster contract, so we only need to compose the
 * markdown body here. The HTML marker is intentionally distinct from
 * the clarification marker so dual-fanout posters can store both
 * comments side-by-side without colliding.
 */
export function renderStalenessWarning(
  candidate: StalenessCandidate,
  closeAfterDays: number,
  warnAfterDays: number,
): string {
  const remaining = Math.max(1, closeAfterDays - warnAfterDays);
  return [
    '<!-- ai-sdlc:dor-stale-warning -->',
    '',
    '## Issue stale — auto-close pending',
    '',
    `This issue has been in **Needs Clarification** for ${warnAfterDays} days with no author activity. If no edits land in the next ${remaining} days it will be **auto-closed** with the \`closed-as-stale-dor\` label.`,
    '',
    'To keep it open: edit the issue body to address the clarifying questions, then comment `/dor-recheck`.',
  ].join('\n');
}

/**
 * Render the auto-close note posted alongside the close action so the
 * thread carries a final message explaining why the issue closed.
 */
export function renderStalenessCloseNote(closedLabel: string, daysInactive: number): string {
  return [
    '<!-- ai-sdlc:dor-stale-close -->',
    '',
    '## Issue auto-closed (stale)',
    '',
    `Closing as stale — no author activity in ${daysInactive} days. Applied label \`${closedLabel}\` for queryability. Reopen and edit the issue body to resume the DoR loop.`,
  ].join('\n');
}
