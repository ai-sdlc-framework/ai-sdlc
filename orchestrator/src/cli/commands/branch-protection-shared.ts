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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface RunCommandAdapter {
  runCommand: (
    cmd: string,
    args: string[],
  ) => { stdout: string; exitCode: number; stderr?: string };
}

export interface OwnerRepoResolution {
  /** The resolved `owner/repo` slug. Present iff `error` is absent. */
  slug?: string;
  /** Default branch of the repository, when `gh` reported one. */
  defaultBranch?: string;
  /** Explains why resolution failed (gh missing, unauthenticated, empty output, etc). */
  error?: string;
}

/**
 * Resolve `owner/repo` and the default branch via one
 * `gh repo view --json nameWithOwner,defaultBranchRef` call. Never
 * throws — failure collapses to `{ error }`.
 */
export function resolveOwnerRepoSlug(adapters: RunCommandAdapter): OwnerRepoResolution {
  const ownerRepo = adapters.runCommand('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner,defaultBranchRef',
    '-q',
    '.nameWithOwner + " " + (.defaultBranchRef.name // "")',
  ]);
  if (ownerRepo.exitCode !== 0) {
    return { error: `gh repo view failed: ${ownerRepo.stdout.trim() || 'unknown error'}` };
  }
  const [slug, defaultBranch] = ownerRepo.stdout.trim().split(/\s+/);
  if (!slug) {
    return { error: 'gh repo view returned empty owner/repo' };
  }
  return defaultBranch ? { slug, defaultBranch } : { slug };
}

/**
 * Read `spec.branching.targetBranch` from `.ai-sdlc/pipeline.yaml`, or
 * undefined when unset (unlike pipeline-cli's `resolveTargetBranch`, which
 * collapses "unset" to `main`).
 */
export function readConfiguredTargetBranch(projectDir: string): string | undefined {
  const path = join(projectDir, '.ai-sdlc', 'pipeline.yaml');
  try {
    if (!existsSync(path)) return undefined;
    const doc = parseYaml(readFileSync(path, 'utf-8')) as {
      spec?: { branching?: { targetBranch?: unknown } };
    } | null;
    const value = doc?.spec?.branching?.targetBranch;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Branch to protect: configured target branch, else the repository default
 * branch, else `main`.
 */
export function resolveProtectedBranch(
  configured: string | undefined,
  defaultBranch: string | undefined,
): string {
  return configured || defaultBranch || 'main';
}

/** Context posted by the scaffolded gate workflow's aggregate job. */
export const PR_READY_CONTEXT = 'ai-sdlc/pr-ready';
/** Context the Codecov GitHub App posts after a coverage upload. */
export const CODECOV_PATCH_CONTEXT = 'codecov/patch';

/**
 * Build the recommended branch-protection ruleset for AI-SDLC adopters
 * (AISDLC-1352). Only contexts the repository's own workflows will post are
 * required: `ai-sdlc/pr-ready` (the gate aggregator) always, `codecov/patch`
 * only when a workflow uploads to Codecov. A required check nobody posts can
 * never pass.
 *
 * The body conforms to the GitHub REST API
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection` schema.
 */
export function buildBranchProtectionBody(contexts: readonly string[]) {
  return {
    required_status_checks: {
      strict: true,
      contexts: [...contexts],
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
}

/** The always-required baseline (no Codecov upload). */
export const RECOMMENDED_BRANCH_PROTECTION_BODY = buildBranchProtectionBody([PR_READY_CONTEXT]);

export interface PostedContexts {
  /** Job names (or ids when unnamed) across the workflow files. */
  jobNames: string[];
  /** True when any workflow step uses `codecov/codecov-action`. */
  uploadsToCodecov: boolean;
}

/** Derive the check contexts a set of workflow files will post. Never throws. */
export function postedContextsFromWorkflows(texts: readonly string[]): PostedContexts {
  const jobNames: string[] = [];
  let uploadsToCodecov = false;
  for (const text of texts) {
    if (/uses:\s*['"]?codecov\/codecov-action/.test(text)) uploadsToCodecov = true;
    try {
      const doc = parseYaml(text) as { jobs?: Record<string, { name?: unknown } | null> } | null;
      for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
        jobNames.push(typeof job?.name === 'string' && job.name ? job.name : id);
      }
    } catch {
      // unparseable workflow: contributes nothing
    }
  }
  return { jobNames, uploadsToCodecov };
}

/** Contexts the scaffolded protection should require for these workflows. */
export function requiredContextsFor(posted: PostedContexts): string[] {
  return posted.uploadsToCodecov ? [PR_READY_CONTEXT, CODECOV_PATCH_CONTEXT] : [PR_READY_CONTEXT];
}

/** Read `.github/workflows/*.yml|yaml` from disk. Never throws. */
export function readWorkflowTextsFs(projectDir: string): string[] {
  const dir = join(projectDir, '.github', 'workflows');
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(join(dir, f), 'utf-8'));
  } catch {
    return [];
  }
}

/** True when a required context is posted by a job name or the Codecov upload. */
export function isContextPosted(context: string, posted: PostedContexts): boolean {
  if (context === CODECOV_PATCH_CONTEXT || context.startsWith('codecov/')) {
    return posted.uploadsToCodecov;
  }
  return posted.jobNames.some((name) => {
    if (name === context) return true;
    if (!name.includes('${{')) return false;
    const re = name
      .split(/\$\{\{.*?\}\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${re}$`).test(context);
  });
}

/**
 * True when `gh api` output from a branch-protection call indicates the
 * API is unavailable for this repo (HTTP 403: GitHub Free private repo
 * without branch protection). AISDLC-748 / DEC-0014: detected at runtime,
 * never by guessing the plan.
 */
export function isBranchProtectionUnavailable(stdout: string, stderr = ''): boolean {
  return /HTTP 403|\(HTTP 403\)|upgrade to github (pro|team)/i.test(`${stdout}\n${stderr}`);
}

/** Exact doctor wording for the client-side-only enforcement finding. */
export const CLIENT_SIDE_ONLY_MESSAGE =
  'enforcement: client-side only; the server cannot block a manual merge';

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
  /** `required_status_checks.contexts` includes `Backlog Drift` (AISDLC-388 contract needs it alongside `ai-sdlc/pr-ready`; AISDLC-582). */
  requiresBacklogDrift: boolean;
  /** All `required_status_checks.contexts` on the protected branch (AISDLC-1352). */
  requiredContexts?: string[];
  /**
   * The branch-protection API returned 403 (GitHub Free private repo):
   * the server cannot enforce, only the client-side merge gate applies.
   */
  apiUnavailable?: boolean;
  /** Branch whose protection was read. */
  branch?: string;
  /** Reason the check could not run, or that the API call failed. */
  error?: string;
}

/**
 * Best-effort read of the live branch-protection ruleset on the target branch, via
 * `gh api`. Never throws — absence of `gh`, missing auth, or an
 * unresolvable remote all collapse to `checked: false` with an
 * explanatory `error` rather than crashing the caller.
 */
export function fetchBranchProtectionStatus(
  adapters: RunCommandAdapter,
  projectDir?: string,
): BranchProtectionCheck {
  const resolved = resolveOwnerRepoSlug(adapters);
  if (!resolved.slug) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      requiresBacklogDrift: false,
      error: resolved.error,
    };
  }

  const branch = resolveProtectedBranch(
    projectDir ? readConfiguredTargetBranch(projectDir) : undefined,
    resolved.defaultBranch,
  );
  const protection = adapters.runCommand('gh', [
    'api',
    `repos/${resolved.slug}/branches/${branch}/protection`,
  ]);
  if (protection.exitCode !== 0) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      requiresBacklogDrift: false,
      apiUnavailable: isBranchProtectionUnavailable(protection.stdout, protection.stderr),
      error: `gh api repos/${resolved.slug}/branches/${branch}/protection failed (branch protection likely not configured)`,
      branch,
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
    const requiresBacklogDrift = contexts.includes('Backlog Drift');
    return {
      checked: true,
      requiresApprovingReview,
      requiresPrReady,
      requiresAttestationDirectly,
      requiresBacklogDrift,
      requiredContexts: contexts,
      branch,
    };
  } catch {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      requiresAttestationDirectly: false,
      requiresBacklogDrift: false,
      error: 'could not parse `gh api .../protection` response as JSON',
    };
  }
}
