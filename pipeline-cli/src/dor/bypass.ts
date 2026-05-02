/**
 * `dor-bypass` label handler (RFC-0011 §7.4 + Phase 6 / AISDLC-115.7).
 *
 * Operator escape hatch for the DoR gate. When a maintainer applies the
 * `dor-bypass` label to an issue, the gate's verdict is overridden:
 *
 *   - The issue is admitted regardless of the rubric verdict.
 *   - The override is logged to the calibration log (`outcome: 'override'`)
 *     so Phase 7's soak math can compute false-positive rate from the
 *     same source of truth — no parallel "overrides" counter required.
 *   - The actor identity, reason text, and (when available) the verdict
 *     snapshot are all captured. A high override rate per maintainer is a
 *     calibration signal (the rubric is too strict) — see RFC §8.4.
 *
 * Trust gating: only contributors named in
 * `.ai-sdlc/trusted-reviewers.yaml` may apply the label. Untrusted actors
 * get `admitted: false` with a deny-reason; the calling shim is
 * responsible for surfacing the denial back to the actor (typically by
 * removing the label + posting a comment).
 *
 * This module is **decision + side-effect-on-the-calibration-log only**.
 * It does NOT interact with GitHub directly — the caller (a GitHub
 * Action workflow or `/ai-sdlc execute` slash command body) drives the
 * label removal / status transition / comment posting. Keeping I/O at
 * the rim mirrors the pattern in `staleness.ts` and `comment-loop.ts`.
 */

import { recordOverride } from './calibration-log.js';
import type { CalibrationEntry, CalibrationLogOpts } from './calibration-log.js';
import { DOR_CONFIG_DEFAULTS, type DorConfig } from './dor-config.js';
import {
  checkActorAllowed,
  type CheckActorOpts,
  type CheckActorResult,
} from './trusted-reviewers-check.js';
import type { RefinementVerdict, IssueInput } from './types.js';

/** Stable label name (RFC §7.4). */
export const DOR_BYPASS_LABEL = 'dor-bypass';

export interface HandleBypassLabelInput {
  /** Issue identifier (e.g. `AISDLC-92`, `gh#42`). */
  issueId: string;
  /** Label that was applied. Must be `dor-bypass` to take effect. */
  label: string;
  /** Actor identity from the trusted source (GitHub event payload, signed token). */
  actor: string;
  /**
   * Free-text reason the maintainer supplied. Per RFC §7.4 the reason
   * is **required** — empty / whitespace-only reasons are rejected with
   * `admitted: false`. The caller should re-prompt the maintainer to
   * include a reason in the label apply event (e.g. via a comment body).
   */
  reason: string;
  /**
   * Verdict snapshot at override time. Optional — when omitted, the
   * calibration log writes a synthetic admit verdict (per
   * `recordOverride()`'s contract). Pass it when an evaluator run is
   * available so the per-gate breakdown survives into the override row.
   */
  verdict?: RefinementVerdict;
  /** Issue snapshot (id / source / title / body). Optional but recommended. */
  issue?: Pick<IssueInput, 'id' | 'source' | 'title' | 'body'>;
}

export interface HandleBypassLabelOpts {
  /** DoR config — drives the trusted-reviewer role requirement. */
  config?: DorConfig;
  /** Trusted-reviewers loader options (workDir / explicit filePath / pre-loaded list). */
  trustedReviewersOpts?: CheckActorOpts;
  /** Calibration log options. Forwarded to `recordOverride()`. */
  calibrationLogOpts?: CalibrationLogOpts;
  /**
   * Override the actor allowlist check entirely. Tests inject a stub
   * to assert that the calibration log writer is NOT called when the
   * check denies, without needing a real reviewers file on disk.
   */
  checkActor?: (actor: string, opts: CheckActorOpts) => CheckActorResult;
}

export interface HandleBypassLabelResult {
  /** Whether the issue is admitted as a result of the label apply. */
  admitted: boolean;
  /**
   * Human-readable reason — drives the calling shim's log line + (on
   * deny) the comment back to the actor explaining why the bypass was
   * refused.
   */
  reason: string;
  /**
   * Calibration log entry written when the bypass was admitted. Absent
   * when admitted is false (no override row is written for a denied
   * bypass — the audit trail there is the GitHub Action log).
   */
  calibrationEntry?: CalibrationEntry;
  /** Path of the calibration log file the entry landed in. */
  calibrationLogPath?: string;
}

/**
 * Handle a `dor-bypass` label apply event end-to-end.
 *
 * Decision tree:
 *
 *   1. Label name MUST be `dor-bypass` exactly. Anything else returns
 *      `admitted: false` with `reason: 'not the dor-bypass label'` —
 *      the shim should ignore those events.
 *   2. Reason MUST be non-empty after trim. Empty reasons are rejected
 *      with `admitted: false` so the audit trail always carries a
 *      maintainer-supplied justification.
 *   3. Actor MUST pass the trusted-reviewer check. Failures return
 *      `admitted: false` with the deny reason from the check.
 *   4. On success: append an `outcome: 'override'` calibration entry
 *      capturing the actor identity + reason + (when supplied) verdict
 *      snapshot, and return `admitted: true`.
 */
export function handleBypassLabel(
  input: HandleBypassLabelInput,
  opts: HandleBypassLabelOpts = {},
): HandleBypassLabelResult {
  if (input.label !== DOR_BYPASS_LABEL) {
    return { admitted: false, reason: `not the ${DOR_BYPASS_LABEL} label` };
  }

  if (!input.reason || !input.reason.trim()) {
    return {
      admitted: false,
      reason: `${DOR_BYPASS_LABEL} requires a non-empty reason (RFC-0011 §7.4)`,
    };
  }

  const config = opts.config ?? DOR_CONFIG_DEFAULTS;
  const checkActor = opts.checkActor ?? checkActorAllowed;
  const check = checkActor(input.actor, {
    ...(opts.trustedReviewersOpts ?? {}),
    requiredRole: config.bypassRequiresRole,
  });

  if (!check.allowed) {
    return { admitted: false, reason: `actor not allowed to bypass: ${check.reason}` };
  }

  const overrideArgs: Parameters<typeof recordOverride>[0] = {
    issueId: input.issueId,
    author: input.actor,
    reason: input.reason.trim(),
  };
  if (input.verdict) overrideArgs.verdict = input.verdict;
  if (input.issue) overrideArgs.issue = input.issue;

  const written = recordOverride(overrideArgs, opts.calibrationLogOpts);

  return {
    admitted: true,
    reason: `bypass admitted by ${input.actor} (role=${config.bypassRequiresRole}); reason logged to calibration`,
    calibrationEntry: written.entry,
    calibrationLogPath: written.path,
  };
}
