/**
 * `ReviewerMajorOrCritical` handler (RFC-0015 §5.1, row 5).
 *
 * Detection: aggregated reviewer verdict has any `critical` or `major`
 * finding. Detection ONLY runs against the structured
 * `failure.reviewerFindings` field — we never grep stderr for this mode
 * because reviewer verdicts come back as JSON.
 *
 * Remediation: re-spawn the dev with the combined reviewer feedback.
 *
 * Budget: 2.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

export const reviewerMajorOrCriticalHandler: Handler = {
  mode: 'ReviewerMajorOrCritical',
  budget: 2,
  detect(ctx: WorkerContext): boolean {
    const f = ctx.failure.reviewerFindings;
    if (!f) return false;
    return (f.critical ?? 0) > 0 || (f.major ?? 0) > 0;
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    if (!deps.redispatch) {
      return {
        status: 'inapplicable',
        note: 'no redispatch hook injected; cannot re-spawn dev with reviewer feedback',
      };
    }
    deps.logger.warn(
      `[playbook/reviewer] re-dispatching ${ctx.taskId} with reviewer feedback (attempt ${
        ctx.attempts + 1
      }/${this.budget})`,
    );
    try {
      const result = await deps.redispatch(ctx.taskId);
      if (result.outcome === 'approved') {
        return {
          status: 'recovered',
          nextState: 'DONE',
          result,
          note: 'dev re-implementation passed review',
        };
      }
      return {
        status: 'retry',
        nextState: 'ITERATE_DEV',
        result,
        note: `dev re-implementation outcome=${result.outcome}`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'retry',
        nextState: 'ITERATE_DEV',
        note: `re-dispatch threw: ${reason}`,
      };
    }
  },
};
