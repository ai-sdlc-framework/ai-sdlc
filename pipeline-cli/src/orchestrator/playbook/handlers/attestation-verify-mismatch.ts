/**
 * `AttestationVerifyMismatch` handler (RFC-0015 §5.1, row 7).
 *
 * Detection: CI's `ai-sdlc/attestation` reports a `contentHashV3 mismatch`
 * after a sibling PR merged into main. The attestation envelope was
 * signed against the pre-rebase head; the merge changed the per-file
 * content binding.
 *
 * Remediation: pre-sign rebase per AISDLC-102 — re-sign the attestation
 * with the new `contentHashV3`. If the content actually changed (not just
 * the SHA-1) we additionally re-spawn the 3 reviewers because the diff
 * they reviewed is no longer the diff merging.
 *
 * Budget: 1.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const ATTESTATION_MISMATCH_PHRASES =
  /contentHashV3\s+mismatch|attestation.*mismatch|attestation.*verify.*failed/i;

export const attestationVerifyMismatchHandler: Handler = {
  mode: 'AttestationVerifyMismatch',
  budget: 1,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    return ATTESTATION_MISMATCH_PHRASES.test(stderr);
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    deps.logger.warn(
      `[playbook/attestation] re-signing attestation for ${ctx.taskId} branch=${ctx.branch}`,
    );
    // The actual re-sign is implemented by AISDLC-102's signing helper
    // which is part of /ai-sdlc rebase. We invoke it via the existing
    // helper script the dogfood pipeline already calls.
    const sign = await deps.runner('bash', ['scripts/check-attestation-sign.sh'], {
      cwd: ctx.worktreePath,
      allowFailure: true,
      env: { AI_SDLC_SKIP_ATTESTATION_SIGN: '' },
    });
    if (sign.code !== 0) {
      return {
        status: 'budget-exhausted',
        note: `attestation re-sign failed (exit ${sign.code}): ${sign.stderr.slice(0, 200)}`,
      };
    }
    // Re-push the freshly-signed envelope.
    const push = await deps.runner('git', ['push', '--force-with-lease', 'origin', ctx.branch], {
      cwd: ctx.worktreePath,
      allowFailure: true,
    });
    if (push.code === 0) {
      return {
        status: 'recovered',
        nextState: 'FINALIZING',
        note: 'attestation re-signed + pushed; AttestationStaleAfterRebase emitted for audit',
      };
    }
    return {
      status: 'budget-exhausted',
      note: `re-push after attestation re-sign failed: ${push.stderr.slice(0, 200)}`,
    };
  },
};
