/**
 * `RebaseConflict` handler (RFC-0015 §5.1, row 3).
 *
 * Detection: `git rebase origin/main` exits non-zero AND the worktree
 * tree contains `<<<<<<< HEAD` conflict markers in at least one file.
 *
 * Remediation: invoke the existing `/ai-sdlc rebase` helper (AISDLC-105)
 * which automates mechanical conflicts (CHANGELOG `Unreleased`,
 * test additions, prettier drift) and re-signs the attestation only when
 * `contentHash` changed. Phase 2 wires the existing tool — no new
 * conflict-resolution logic.
 *
 * Budget: 1 — `/ai-sdlc rebase` already has its own internal 3-attempt
 * iteration cap; the playbook just kicks it off once and lets the
 * existing escalation surface own the rest. RFC §5.1 explicitly defers
 * to AISDLC-105's escalation here.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const CONFLICT_MARKER = /<<<<<<<\s+HEAD/m;
const REBASE_FAILURE = /could not apply|CONFLICT|Failed to merge in the changes/i;

export const rebaseConflictHandler: Handler = {
  mode: 'RebaseConflict',
  budget: 1,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    // Either explicit rebase failure phrasing or conflict markers present.
    return REBASE_FAILURE.test(stderr) || CONFLICT_MARKER.test(stderr);
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    deps.logger.warn(
      `[playbook/rebase-conflict] invoking rebase-resolver for ${ctx.taskId} branch=${ctx.branch}`,
    );
    // The actual rebase-resolver is a subagent invocation. The injected
    // `redispatch` is the bridge: it re-runs the worker's pipeline; the
    // pipeline's Step 5 (or operator's `/ai-sdlc rebase` flow) is what
    // actually resolves. If no redispatch is available we mark the
    // remediation as inapplicable and let the runner escalate.
    if (!deps.redispatch) {
      return {
        status: 'inapplicable',
        note: 'no redispatch hook injected; cannot drive rebase-resolver',
      };
    }
    try {
      const result = await deps.redispatch(ctx.taskId);
      if (result.outcome === 'approved') {
        return {
          status: 'recovered',
          nextState: 'DONE',
          result,
          note: 'rebase resolved + pipeline drained',
        };
      }
      return {
        status: 'budget-exhausted',
        note: `rebase resolver returned outcome=${result.outcome}; escalating per AISDLC-105`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'budget-exhausted',
        note: `rebase resolver threw: ${reason}; escalating`,
      };
    }
  },
};
