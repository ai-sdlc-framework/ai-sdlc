/**
 * Filter — Captures-pending detection (RFC-0024 §9.3 / AISDLC-269).
 *
 * Refuses to dispatch an Issue if it has any unresolved capture (triage=tbd)
 * referencing it via `relatedIssueId` or `blocksIssueId`. This prevents the
 * orchestrator from re-dispatching work that the operator hasn't yet finished
 * triaging — the "decision-pending → decision-deferred handoff" per RFC-0024
 * §9.2.
 *
 * The filter is DEGRADE-OPEN: when the emergent-capture feature flag
 * (`AI_SDLC_EMERGENT_CAPTURE`) is not set, the filter always passes.
 * When the flag is set and there are pending captures for the candidate,
 * the filter rejects with a `CapturesPendingDetail` payload so the loop
 * can emit `OrchestratorBlockedByCapturesPending`.
 *
 * Filter position: AFTER Blocked (last in the chain), inserted as a
 * post-Blocked guard so tasks with terminal blockers skip the capture
 * corpus scan entirely.
 *
 * Pure aside from the filesystem read of `$ARTIFACTS_DIR/_captures/`.
 *
 * @module orchestrator/filters/captures-pending
 */

import { hasPendingCapturesForIssue } from '../../capture/capture-reader.js';
import type { FilterResult } from './types.js';

// ── Feature flag ──────────────────────────────────────────────────────────────

const TRUTHY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on', 'experimental']);

function isCaptureFlagEnabled(env?: Record<string, string | undefined>): boolean {
  const val = (env ?? process.env).AI_SDLC_EMERGENT_CAPTURE ?? '';
  return TRUTHY_FLAG_VALUES.has(val.toLowerCase());
}

// ── Detail type ───────────────────────────────────────────────────────────────

/**
 * Structured detail carried in the (future) `OrchestratorBlockedByCapturesPending`
 * event. Discriminated by `kind: 'captures-pending'`.
 */
export interface CapturesPendingDetail {
  kind: 'captures-pending';
  /**
   * The issue ID that has unresolved captures referencing it.
   */
  issueId: string;
  /**
   * Human advisory for the operator: check `cli-capture list --pending`
   * to see what needs triaging.
   */
  advisory: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface CheckCapturesPendingOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Override `$ARTIFACTS_DIR` — used to locate the captures directory.
   * When undefined, falls back to `process.env.ARTIFACTS_DIR` then
   * `./_artifacts`.
   */
  artifactsDir?: string;
  /**
   * Inject `hasPendingCapturesForIssue` for tests so they don't need a
   * real filesystem. Defaults to the real reader.
   */
  hasPendingCaptures?: (issueId: string, artifactsDir?: string) => boolean;
  /**
   * Inject environment for feature-flag detection (tests). Defaults to
   * `process.env`.
   */
  env?: Record<string, string | undefined>;
}

// ── Filter ────────────────────────────────────────────────────────────────────

/**
 * Check whether the candidate task has unresolved emergent captures (triage=tbd)
 * referencing it.
 *
 * Returns `{ filter: 'CapturesPending', passed: false, ... }` when the
 * flag is enabled and captures are pending; returns
 * `{ filter: 'CapturesPending', passed: true }` otherwise (including when the
 * flag is disabled, which is the default degrade-open path).
 */
export function checkCapturesPending(opts: CheckCapturesPendingOpts): FilterResult {
  // Degrade-open: feature flag must be enabled.
  if (!isCaptureFlagEnabled(opts.env)) {
    return { filter: 'CapturesPending', passed: true };
  }

  const check = opts.hasPendingCaptures ?? hasPendingCapturesForIssue;
  const hasPending = check(opts.taskId, opts.artifactsDir);

  if (!hasPending) {
    return { filter: 'CapturesPending', passed: true };
  }

  const detail: CapturesPendingDetail = {
    kind: 'captures-pending',
    issueId: opts.taskId,
    advisory:
      `Task ${opts.taskId} has unresolved emergent captures (triage=tbd). ` +
      `Run \`cli-capture list --pending\` to review and triage before dispatch.`,
  };

  return {
    filter: 'CapturesPending',
    passed: false,
    reason: `task ${opts.taskId} has pending captures (triage=tbd) — triage required before dispatch`,
    detail,
  };
}
