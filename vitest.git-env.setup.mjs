/**
 * Vitest per-worker setup: drop inherited git repository variables.
 *
 * Incident 2026-10-30. `git push` from a linked worktree exports GIT_DIR (an
 * absolute path into the SHARED `.git`) and GIT_PREFIX to its hooks; the
 * pre-push patch-coverage gate ran this suite with them set. Every test that
 * shells out to git inside a temp fixture then acted on the real repository:
 * `git init --bare` flipped its core.bare, checkouts moved its HEAD, and one
 * teardown resolved `rev-parse --git-common-dir` to the real `.git` and
 * `rmSync`'d the directory above it, deleting the parent checkout and every
 * worktree. The hook now unsets the variables too; this file is the second
 * layer so no runner, IDE or CI harness can reintroduce the leak.
 *
 * Only repository-location variables are removed. GIT_AUTHOR_*, GIT_EDITOR,
 * GIT_CONFIG_* and friends are left alone because tests rely on them.
 */
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) {
  delete process.env[k];
}

// Hierarchy session identity (executor/planner panes) must not leak into tests:
// running the suite from an executor session made the lease-push preflight
// refuse every step-11 test (AISDLC-1150 verification).
for (const k of [
  'AI_SDLC_HIERARCHY_ROLE',
  'AI_SDLC_HIERARCHY_SESSION',
  'AI_SDLC_EXECUTOR_TASK',
  'CLAUDE_PROJECT_DIR',
]) {
  delete process.env[k];
}
