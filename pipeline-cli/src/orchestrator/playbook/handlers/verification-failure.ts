/**
 * `VerificationFailure` handler (RFC-0015 §5.1, row 4).
 *
 * Detection: `pnpm build|test|lint|format` exits non-zero in the dev's
 * verify stage. The failure source is one of those tool names + a
 * non-zero exit code; we don't need a tight stderr regex because the
 * exit-code + tool-name combo is unambiguous.
 *
 * Remediation: re-spawn the dev with the combined verification stderr
 * as feedback. Matches `/ai-sdlc execute` Step 9.
 *
 * Budget: 2 — same as `/ai-sdlc execute` (one initial run + one retry
 * after CHANGES_REQUESTED-style feedback).
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const VERIFY_TOOLS = /pnpm\s+(build|test|lint|format)|vitest|tsc|eslint|prettier/i;
const VERIFY_FAILURE_PHRASES = /failed|exit (code )?(?!0)\d|FAIL|✗/i;

export const verificationFailureHandler: Handler = {
  mode: 'VerificationFailure',
  budget: 2,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    if (ctx.failure.exitCode === 0 || ctx.failure.exitCode === null) return false;
    if (!VERIFY_TOOLS.test(stderr)) return false;
    return VERIFY_FAILURE_PHRASES.test(stderr);
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    if (!deps.redispatch) {
      return {
        status: 'inapplicable',
        note: 'no redispatch hook injected; cannot re-spawn dev with stderr feedback',
      };
    }
    deps.logger.warn(
      `[playbook/verification] re-dispatching ${ctx.taskId} with verify stderr feedback (attempt ${
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
          note: 'dev re-implementation passed verification',
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
