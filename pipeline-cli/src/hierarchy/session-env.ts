/**
 * Hierarchy session env vars (AISDLC-1153).
 *
 * An executor session exports these to its shell (`buildClaudeCommand`, `up.ts`). They must not
 * leak into the verify gate's `pnpm test`: the lease-push preflight reads them and refuses
 * `not-task-worktree` for ~36 pipeline-cli tests. `vitest.git-env.setup.mjs` mirrors this list
 * (a test fails on drift).
 *
 * @module hierarchy/session-env
 */

export const HIERARCHY_SESSION_ENV_VARS = [
  'AI_SDLC_HIERARCHY_SESSION',
  'AI_SDLC_HIERARCHY_ROLE',
  'AI_SDLC_EXECUTOR_TASK',
  'CLAUDE_PROJECT_DIR',
  'AI_SDLC_GH_CALL_LOG',
  // Regression guard, not the fix (AISDLC-1155): the engine no longer sets this on process.env;
  // the ship step passes it only to the sign/push spawns. verifyV6Envelope reads it, so keep it
  // stripped in case an operator or a future caller leaks it into a verify child.
  'AI_SDLC_WORKFLOW_STATE',
] as const;

/**
 * Env overrides that remove the session vars from a spawned child. The runner spreads
 * `process.env` first, then these; an `undefined` value is omitted by Node's spawn.
 */
export function strippedSessionEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of HIERARCHY_SESSION_ENV_VARS) env[k] = undefined;
  return env;
}
