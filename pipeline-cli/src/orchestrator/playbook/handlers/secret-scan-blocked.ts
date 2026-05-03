/**
 * `SecretScanBlocked` handler (RFC-0015 §5.1, row 1).
 *
 * Detection: `git push` rejected with `push declined due to repository
 * rule violations` AND a `Secret Scanning` mention in stderr.
 *
 * Remediation: identify the blocked file/line from the GitHub error
 * payload (gh push prints the offending blob + line range), reformat the
 * literal-secret pattern to template-literal construction (the canonical
 * dogfood fix from PR #154 / AISDLC-126), recommit, retry push.
 *
 * Budget: 2 — one to attempt the reformat, one to retry if the first
 * attempt missed an additional location in the same diff.
 *
 * Escalation: tag PR with `needs-human-attention` (handled by the
 * playbook-runner's generic escalator).
 *
 * Phase 2 NOTE: the actual literal→template-literal rewrite is the
 * subagent-driven part — Phase 2 ships the DETECTION + retry-loop
 * scaffolding + an injectable `redispatch` so a higher tier (the dev
 * agent) can do the actual content edit. The handler is intentionally
 * conservative on its own — it never edits source files directly. This
 * matches RFC §13 Q4's audit checklist (no out-of-worktree writes, no
 * shared-state mutation) and §13 Q8's bias toward escalation when the
 * fix is non-mechanical.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const SECRET_SCAN_PATTERNS = [
  /push declined due to repository rule violations/i,
  /Secret Scanning/i,
  /secret_scanning_push_protection/i,
];

export const secretScanBlockedHandler: Handler = {
  mode: 'SecretScanBlocked',
  budget: 2,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    // Require BOTH the push-declined header AND a secret-scanning mention
    // — the rule-violation header alone fires for branch-protection,
    // CODEOWNERS, etc. and we don't want to misroute those into the
    // secret-reformat handler (RFC §13 Q8: bias toward conservative
    // matching over autonomous miscategorisation).
    return (
      SECRET_SCAN_PATTERNS[0]!.test(stderr) &&
      (SECRET_SCAN_PATTERNS[1]!.test(stderr) || SECRET_SCAN_PATTERNS[2]!.test(stderr))
    );
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforcement lives in the runner (`playbook-runner.ts`) — this
    // handler reports what THIS attempt produced and lets the runner
    // decide whether to retry or escalate. The runner reads the effective
    // budget from the YAML catalogue so operator overrides win.
    if (!deps.redispatch) {
      // Without a redispatch hook the handler can't drive the dev to
      // rewrite the literal-secret pattern. Return inapplicable so the
      // runner falls through to escalation.
      return {
        status: 'inapplicable',
        note: 'no redispatch hook injected; cannot drive literal→template rewrite',
      };
    }
    // Re-spawn the dev with the secret-scan stderr as feedback. The dev
    // subagent owns the actual rewrite; this handler is the loop driver.
    deps.logger.warn(
      `[playbook/secret-scan] re-dispatching ${ctx.taskId} (attempt ${ctx.attempts + 1}/${this.budget})`,
    );
    try {
      const result = await deps.redispatch(ctx.taskId);
      // The redispatch returned without throwing — we count it as a
      // recovery attempt regardless of `outcome` because the dev got the
      // feedback; the runner will assess whether the new run pushed
      // cleanly via its normal verify path.
      return {
        status: result.outcome === 'approved' ? 'recovered' : 'retry',
        nextState: result.outcome === 'approved' ? 'DONE' : 'REMEDIATE_SECRETSCAN',
        result,
        note: `redispatch outcome=${result.outcome}`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'retry',
        nextState: 'REMEDIATE_SECRETSCAN',
        note: `redispatch threw: ${reason}`,
      };
    }
  },
};
