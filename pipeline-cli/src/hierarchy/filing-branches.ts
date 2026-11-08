/**
 * Head-branch prefixes `cli-file` opens its filing PRs from (AISDLC-1235). `cli-file` and the
 * reconciler's docs lane both read these, so a new filing shape cannot be classified as a task PR.
 */
export const FILE_BRANCH_PREFIX = 'ai-sdlc/file-';
/** `cli-file task --update` branch: `ai-sdlc/update-<id>`. */
export const UPDATE_BRANCH_PREFIX = 'ai-sdlc/update-';
