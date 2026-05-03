/**
 * `EnvHookFailure` handler (RFC-0015 §5.1, row 6).
 *
 * Detection: husky pre-commit fails with `tsc not found` / similar
 * env-not-tooling error. The dev's repo has working tools but the hook
 * runner can't find them (PATH issue, missing global, etc.).
 *
 * Remediation: retry with `--no-verify` ONLY when the change is data-only
 * (paths confined to `backlog/`, `docs/`, `spec/`, root markdown — no
 * source code). Emits `EnvHookSkipped` for audit. Source-code-touching
 * commits are NEVER retried with `--no-verify`; those get escalated.
 *
 * Budget: 1.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const ENV_FAILURE_PHRASES =
  /tsc(:|\s)+not found|command not found|husky.*not found|node:.*Cannot find module|ENOENT.*executable/i;

const SOURCE_PATH_HINTS = [/^pipeline-cli\/src\//, /^ai-sdlc-plugin\//, /\.(ts|tsx|mjs|cjs|js)$/];
const DATA_ONLY_PATH_HINTS = [
  /^backlog\//,
  /^docs\//,
  /^spec\//,
  /^\.ai-sdlc\//,
  /^[^/]+\.md$/, // root markdown
];

export function isDataOnlyChange(paths: readonly string[] | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  for (const p of paths) {
    const normalised = p.replace(/^\.\//, '');
    if (SOURCE_PATH_HINTS.some((re) => re.test(normalised))) return false;
    if (!DATA_ONLY_PATH_HINTS.some((re) => re.test(normalised))) return false;
  }
  return true;
}

export const envHookFailureHandler: Handler = {
  mode: 'EnvHookFailure',
  budget: 1,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    return ENV_FAILURE_PHRASES.test(stderr);
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    if (!isDataOnlyChange(ctx.failure.changedPaths)) {
      // Source-touching commits MUST NOT bypass the gate. Escalate.
      return {
        status: 'budget-exhausted',
        note: 'change touches source code; refusing --no-verify retry per §5.1',
      };
    }
    deps.logger.warn(
      `[playbook/env-hook] retrying push with --no-verify for ${ctx.taskId} (data-only change)`,
    );
    // Re-attempt the push bypassing the env-broken hook. We log this as
    // an audit event in the runner (`EnvHookSkipped`); the bypass is
    // intentionally narrow (data-only) per RFC §5.1.
    const push = await deps.runner(
      'git',
      ['push', '--no-verify', '--force-with-lease', 'origin', ctx.branch],
      {
        cwd: ctx.worktreePath,
        allowFailure: true,
      },
    );
    if (push.code === 0) {
      return {
        status: 'recovered',
        nextState: 'FINALIZING',
        note: '--no-verify push succeeded; EnvHookSkipped audit emitted',
      };
    }
    return {
      status: 'budget-exhausted',
      note: `--no-verify push still failing: ${push.stderr.slice(0, 200)}`,
    };
  },
};
