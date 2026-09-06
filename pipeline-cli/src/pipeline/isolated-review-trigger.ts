/**
 * RFC-0046 Phase 3 (AISDLC-590) — opt-in trigger + CI-provenance helpers for
 * the `isolated` internal-review tier.
 *
 * Pure functions, no I/O — hermetically testable. Two responsibilities:
 *
 * 1. **Opt-in gate** (`isIsolatedReviewRequested`) — the `isolated` tier is
 *    NEVER run for routine PRs (cost: a full RFC-0043 sandbox spin-up per
 *    review). It only engages when a PR explicitly requests it via a label
 *    or an operator/workflow_dispatch input. Default: false.
 *
 * 2. **CI provenance derivation** (`computeCiProvenance`) — the re-derivable
 *    anchor for `independenceTier: 'isolated'` (RFC-0046 OQ-2) requires
 *    `provenance.deployment === 'ci'`. This module derives that provenance
 *    from the ambient GitHub Actions environment so the sandbox/reviewer
 *    pipeline can populate `UntrustedPrReport.provenance` before handing the
 *    report to the clean-room signer (`clean-room-signer.ts`'s anchor check
 *    enforces the gate on the signing side).
 *
 * @module pipeline/isolated-review-trigger
 */

/** The PR label that opts a PR into the `isolated` independence tier. */
export const ISOLATED_REVIEW_LABEL = 'isolated-review';

/** Env var that opts a manual/workflow_dispatch run into the `isolated` tier. */
export const ISOLATED_REVIEW_ENV_VAR = 'AI_SDLC_ISOLATED_REVIEW';

/**
 * Determine whether a PR has opted into the `isolated` independence tier.
 *
 * Opt-in only (RFC-0046 OQ-5 resolution): routine PRs MUST NOT be sandboxed
 * by default — the `isolated` tier's sandbox spin-up cost is deliberate,
 * spent only when a PR (or operator) explicitly asks for it.
 *
 * Two independent triggers (either is sufficient):
 *   - The PR carries the `isolated-review` label.
 *   - The `AI_SDLC_ISOLATED_REVIEW` env var is truthy (1/true/yes/on,
 *     case-insensitive) — for `workflow_dispatch` / manual/operator runs.
 */
export function isIsolatedReviewRequested(opts: {
  labels?: readonly string[];
  env?: Record<string, string | undefined>;
}): boolean {
  const labels = opts.labels ?? [];
  if (labels.includes(ISOLATED_REVIEW_LABEL)) return true;

  const env = opts.env ?? process.env;
  const val = (env[ISOLATED_REVIEW_ENV_VAR] ?? '').toLowerCase().trim();
  return val === '1' || val === 'true' || val === 'yes' || val === 'on';
}

/**
 * Sandbox/report provenance shape (mirrors `UntrustedPrReportSchema.provenance`).
 */
export interface SandboxProvenance {
  deployment: 'ci' | 'local';
  runId?: string;
  workflowRef?: string;
}

/**
 * Derive sandbox execution provenance from the ambient environment.
 *
 * `deployment: 'ci'` is asserted ONLY when `GITHUB_ACTIONS === 'true'` — the
 * canonical, GitHub-set signal that this process is running on a GitHub-hosted
 * (or self-hosted) Actions runner, infrastructure distinct from the
 * coordinator's own machine (RFC-0046 OQ-1's threat boundary). Any other
 * environment (including a coordinator manually setting `GITHUB_ACTIONS=true`
 * on its own machine) is NOT re-derivable by a third party the way an actual
 * GitHub Actions run is — the `runId`/`workflowRef` fields let a verifier or
 * operator independently confirm the run via the GitHub API — but the anchor
 * decision itself is enforced downstream by `clean-room-signer.ts`, which
 * requires `deployment === 'ci'` before minting the `isolated` claim, and by
 * the actual security boundary: the signing key only ever reaches the
 * clean-room-sign CI job, never the sandbox-run job or any local process.
 */
export function computeCiProvenance(
  env: Record<string, string | undefined> = process.env,
): SandboxProvenance {
  const isGitHubActions = (env['GITHUB_ACTIONS'] ?? '').toLowerCase() === 'true';
  if (!isGitHubActions) {
    return { deployment: 'local' };
  }
  const provenance: SandboxProvenance = { deployment: 'ci' };
  if (env['GITHUB_RUN_ID']) provenance.runId = env['GITHUB_RUN_ID'];
  if (env['GITHUB_WORKFLOW_REF']) provenance.workflowRef = env['GITHUB_WORKFLOW_REF'];
  return provenance;
}
