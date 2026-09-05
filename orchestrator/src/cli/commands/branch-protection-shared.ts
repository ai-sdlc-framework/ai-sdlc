/**
 * Shared branch-protection primitives (AISDLC-578 reconciled minor from the
 * AISDLC-560 review).
 *
 * `init-features.ts`'s `applyBranchProtection()` (writes the recommended
 * ruleset) and `doctor.ts`'s `checkBranchProtection()` (reads the current
 * ruleset for audit) both need to resolve the repo's `owner/repo` slug via
 * `gh repo view` before they can call `gh api .../branches/main/protection`.
 * That resolution logic was duplicated verbatim in both files. This module
 * is the single implementation both call, so the two can't independently
 * drift (e.g. one tightening its error message while the other doesn't).
 *
 * `RECOMMENDED_BRANCH_PROTECTION_BODY` also lives here as the canonical
 * definition of "what branch protection on `main` SHOULD look like" —
 * `init-features.ts` re-exports it for backward compatibility with existing
 * importers.
 */

export interface RunCommandAdapter {
  runCommand: (cmd: string, args: string[]) => { stdout: string; exitCode: number };
}

export interface OwnerRepoResolution {
  /** The resolved `owner/repo` slug. Present iff `error` is absent. */
  slug?: string;
  /** Explains why resolution failed (gh missing, unauthenticated, empty output, etc). */
  error?: string;
}

/**
 * Resolve `owner/repo` via `gh repo view --json nameWithOwner`. Never
 * throws — failure collapses to `{ error }`.
 */
export function resolveOwnerRepoSlug(adapters: RunCommandAdapter): OwnerRepoResolution {
  const ownerRepo = adapters.runCommand('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '-q',
    '.nameWithOwner',
  ]);
  if (ownerRepo.exitCode !== 0) {
    return { error: `gh repo view failed: ${ownerRepo.stdout.trim() || 'unknown error'}` };
  }
  const slug = ownerRepo.stdout.trim();
  if (!slug) {
    return { error: 'gh repo view returned empty owner/repo' };
  }
  return { slug };
}

/**
 * Recommended branch-protection ruleset for AI-SDLC adopters. The required
 * checks are `ai-sdlc/pr-ready` (the gate aggregator) and `codecov/patch`
 * (the de facto coverage signal). Other AI-SDLC apps post their own
 * statuses but they're all rolled into pr-ready.
 *
 * The body conforms to the GitHub REST API
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection` schema.
 */
export const RECOMMENDED_BRANCH_PROTECTION_BODY = {
  required_status_checks: {
    strict: true,
    contexts: ['ai-sdlc/pr-ready', 'codecov/patch'],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};

export interface BranchProtectionCheck {
  /**
   * Whether the check actually ran (i.e. `gh` was available, on PATH,
   * authenticated, and the repo has a resolvable owner/repo). When
   * false, `requiresApprovingReview` / `requiresPrReady` are always
   * false and `error` explains why.
   */
  checked: boolean;
  /** `required_pull_request_reviews.required_approving_review_count >= 1`. */
  requiresApprovingReview: boolean;
  /** `required_status_checks.contexts` includes `ai-sdlc/pr-ready`. */
  requiresPrReady: boolean;
  /** `required_status_checks.contexts` includes `ai-sdlc/attestation` directly (AISDLC-388 misconfiguration). */
  requiresAttestationDirectly: boolean;
  /** Reason the check could not run, or that the API call failed. */
  error?: string;
}

/**
 * Best-effort read of the live branch-protection ruleset on `main`, via
 * `gh api`. Never throws — absence of `gh`, missing auth, or an
 * unresolvable remote all collapse to `checked: false` with an
 * explanatory `error` rather than crashing the caller.
 */
export function fetchBranchProtectionStatus(adapters: RunCommandAdapter): BranchProtectionCheck {
  const resolved = resolveOwnerRepoSlug(adapters);
  if (!resolved.slug) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      error: resolved.error,
    };
  }

  const protection = adapters.runCommand('gh', [
    'api',
    `repos/${resolved.slug}/branches/main/protection`,
  ]);
  if (protection.exitCode !== 0) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      error: `gh api repos/${resolved.slug}/branches/main/protection failed (branch protection likely not configured)`,
    };
  }

  try {
    const body = JSON.parse(protection.stdout) as {
      required_pull_request_reviews?: { required_approving_review_count?: number };
      required_status_checks?: { contexts?: string[] };
    };
    const contexts = body.required_status_checks?.contexts ?? [];
    const requiresApprovingReview =
      (body.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1;
    const requiresPrReady = contexts.includes('ai-sdlc/pr-ready');
    const requiresAttestationDirectly = contexts.includes('ai-sdlc/attestation');
    return { checked: true, requiresApprovingReview, requiresPrReady, requiresAttestationDirectly };
  } catch {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      error: 'could not parse `gh api .../protection` response as JSON',
    };
  }
}
