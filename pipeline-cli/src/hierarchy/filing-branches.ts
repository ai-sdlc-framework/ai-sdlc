/**
 * Head-branch prefixes `cli-file` opens its filing PRs from (AISDLC-1235). `cli-file` and the
 * reconciler's docs lane both read these, so a new filing shape cannot be classified as a task PR.
 */
export const FILE_BRANCH_PREFIX = 'ai-sdlc/file-';
/** `cli-file task --update` branch: `ai-sdlc/update-<id>`. */
export const UPDATE_BRANCH_PREFIX = 'ai-sdlc/update-';
/** Head branches the reconciler's docs lane owns (never a task manifest's branch). */
export const DOCS_BRANCH_PREFIXES = [FILE_BRANCH_PREFIX, UPDATE_BRANCH_PREFIX, 'docs/'] as const;

/** True when a head branch is a filing/docs branch (AISDLC-1248); shared by every guard. */
export function isFilingBranch(branch: string | undefined): boolean {
  return DOCS_BRANCH_PREFIXES.some((p) => (branch ?? '').startsWith(p));
}
