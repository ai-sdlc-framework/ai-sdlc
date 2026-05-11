/**
 * Hermetic git env for orchestrator test fixtures (AISDLC-257).
 *
 * Cross-link: mirrors `pipeline-cli/src/__test-helpers/git-env.ts` (AISDLC-253).
 * See that file for the canonical rationale. This copy exists so orchestrator
 * tests don't take a cross-package import dependency on pipeline-cli's test
 * helpers.
 *
 * Why this exists
 * ───────────────
 * Test fixtures that shell out to `git` (e.g. `execSync('git init', { cwd: d })`)
 * are vulnerable to env-var bleed from the parent shell:
 *
 *   - `GIT_DIR=...` overrides cwd-based repo discovery — every git command
 *     writes into the parent shell's GIT_DIR, NOT the fixture's `cwd`.
 *   - `GIT_WORK_TREE=...` ditto for the working tree.
 *   - `core.hooksPath` from system/global config can fire husky hooks during
 *     fixture commits.
 *   - `commit.gpgsign=true` from operator config can break unattended commits.
 *
 * The `cleanGitEnv()` helper in `orchestrator/src/runtime/git-env.ts` strips
 * GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE but still inherits `process.env`
 * in full, meaning `git config user.email` writes still land wherever git
 * resolves config (which may be a polluted GIT_DIR or the operator's global
 * config). AISDLC-257 identified `worktree-pool.integration.test.ts` as the
 * confirmed leak source.
 *
 * `makeGitEnv()` uses an ALLOW-LIST approach rather than a DENY-LIST: it
 * constructs a minimal env from scratch, deliberately omitting GIT_DIR and
 * GIT_WORK_TREE. Identity is provided via `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * env vars so fixtures never need `git config user.email`.
 *
 * Pattern (matches pipeline-cli AISDLC-253 + orchestrator AISDLC-241/246):
 *
 *   const env = makeGitEnv();
 *   execSync('git init -b main', { cwd: repoDir, env, stdio: 'pipe' });
 *   // No `git config user.email` needed — identity comes from GIT_AUTHOR_*
 */

export function makeGitEnv(): NodeJS.ProcessEnv {
  return {
    // Minimal OS plumbing.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    ...(process.env['TEMP'] ? { TEMP: process.env['TEMP'] } : {}),
    ...(process.env['TMP'] ? { TMP: process.env['TMP'] } : {}),
    // Locale — prevent non-ASCII error strings in git output.
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    LC_ALL: 'C',
    // Git identity — supplied via env so `git config user.email/user.name`
    // is never needed inside the fixture (those writes would land in either
    // the fixture's .git/config or, if GIT_DIR is polluted, in the host
    // worktree's config).
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
    // Disable system + global git config to prevent gpgsign / hookPath /
    // user-config bleed from the operator's machine.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Disable husky so the calling project's pre-commit hooks don't fire.
    HUSKY: '0',
    // Suppress credential helpers / interactive prompts.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    // Note: deliberately NO `GIT_DIR` / `GIT_WORK_TREE` keys — by omitting
    // them from the returned object, child processes inherit nothing for
    // those vars (the env REPLACES the parent's env when passed to execSync,
    // it doesn't merge). That's the load-bearing guarantee against the leak.
  };
}
