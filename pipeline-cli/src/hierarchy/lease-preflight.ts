/**
 * Lease-push preflight (AISDLC-798): runs the SAME predicate the PreToolUse hook
 * applies to an executor's lease push (`evaluateLeasePush` in the plugin's
 * `hooks/lib/trusted-policy.js`) before the pipeline spends reviews and signing,
 * and renders each unmet condition with its sanctioned fix. The plugin module is
 * loaded, not ported, so the preflight and the hook cannot drift; when it cannot
 * be found (a project that does not carry the plugin source) the preflight is
 * `skipped` and never blocks.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** One unmet lease-push condition. */
export interface LeaseCondition {
  condition: string;
  found: string;
  expected: string;
  fix: string;
}

/** The slice of the plugin's trusted-policy module the preflight uses. */
export interface PolicyModule {
  evaluateLeasePush: (args: {
    projectDir: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    branch?: string;
    boardDir?: string;
  }) => { allowed: boolean; failing: LeaseCondition[]; shape?: string };
  inspectInflightClaim: (
    boardDir: string,
    taskId: string,
    env: NodeJS.ProcessEnv,
  ) => { held: boolean; failing: LeaseCondition[] };
  renderLeaseFailing: (failing: LeaseCondition[]) => string;
}

/** Outcome of a preflight. `blocking` is true only for a dispatch-managed session. */
export interface LeasePreflight {
  status: 'allowed' | 'refused' | 'skipped';
  blocking: boolean;
  failing: LeaseCondition[];
  message: string;
}

export interface LeasePreflightOptions {
  /** The session's project dir (`CLAUDE_PROJECT_DIR` when set and absolute, else the repo root). */
  projectDir: string;
  /** The task worktree the push runs from. */
  cwd: string;
  /** Task id, any case; used to tell whether the dispatch board manages this session. */
  taskId: string;
  branch?: string;
  env?: NodeJS.ProcessEnv;
  boardDir?: string;
  /** Replaces the plugin module lookup (tests). */
  load?: () => PolicyModule | null;
}

const POLICY_REL = path.join('hooks', 'lib', 'trusted-policy.js');

const SKIPPED: LeasePreflight = {
  status: 'skipped',
  blocking: false,
  failing: [],
  message: 'lease-push preflight skipped: the plugin hook policy module was not found',
};

/** Finds and loads the plugin's trusted-policy module, or null when it is not on disk. */
export function loadPolicyModule(
  startDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): PolicyModule | null {
  const candidates: string[] = [];
  if (env['CLAUDE_PLUGIN_ROOT']) candidates.push(path.join(env['CLAUDE_PLUGIN_ROOT'], POLICY_REL));
  for (const start of startDirs) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      candidates.push(path.join(dir, 'ai-sdlc-plugin', POLICY_REL));
      if (path.dirname(dir) === dir) break;
    }
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) return null;
  try {
    return createRequire(import.meta.url)(found) as PolicyModule;
  } catch {
    return null;
  }
}

/** True when the dispatch board holds an inflight manifest for the task (a dispatched task). */
function boardManages(boardDir: string, taskId: string): boolean {
  try {
    return readdirSync(path.join(boardDir, 'inflight')).some(
      (f) => f.toLowerCase() === `${taskId.toLowerCase()}.dispatch.json`,
    );
  } catch {
    return false;
  }
}

function render(mod: PolicyModule, failing: LeaseCondition[], where: string): string {
  return (
    `lease-push preflight (${where}): the PreToolUse hook would refuse this session's lease push ` +
    `with not-task-worktree. Unmet conditions:\n${mod.renderLeaseFailing(failing)}`
  );
}

/**
 * Evaluates the hook's lease predicate for a task worktree. A refusal is `blocking`
 * only when the session is dispatch-managed (a hierarchy executor, or the board holds
 * the task): an operator running `/ai-sdlc execute` by hand makes a plain push, which
 * the lease predicate does not govern, so for them it is advice.
 */
export function leasePushPreflight(opts: LeasePreflightOptions): LeasePreflight {
  const env = opts.env ?? process.env;
  const mod = (opts.load ?? (() => loadPolicyModule([opts.projectDir, opts.cwd], env)))();
  if (!mod) return SKIPPED;
  const r = mod.evaluateLeasePush({
    projectDir: opts.projectDir,
    cwd: opts.cwd,
    env,
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    ...(opts.boardDir !== undefined ? { boardDir: opts.boardDir } : {}),
  });
  if (r.allowed) {
    return {
      status: 'allowed',
      blocking: false,
      failing: [],
      message:
        r.shape === 'planner-filing'
          ? 'lease-push preflight: allowed (accepted shape: planner-filing, DEC-0088: planner session, .worktrees/file-<x>, branch ai-sdlc/file-<x>)'
          : 'lease-push preflight: allowed (accepted shape: executor-task)',
    };
  }
  const managed =
    env['AI_SDLC_HIERARCHY_ROLE'] === 'executor' ||
    boardManages(opts.boardDir ?? path.join(opts.projectDir, '.ai-sdlc', 'dispatch'), opts.taskId);
  return {
    status: 'refused',
    blocking: managed,
    failing: r.failing,
    message: render(mod, r.failing, opts.cwd),
  };
}

/**
 * The claim-time half: right after `executor-start` claimed a task and wrote its
 * heartbeat the worktree does not exist yet, so only the session env, the single
 * claim and the heartbeat can be checked. Same module, same conditions.
 */
export function claimPreflight(
  boardDir: string,
  taskId: string,
  env: NodeJS.ProcessEnv,
  startDirs: string[],
  load: () => PolicyModule | null = () => loadPolicyModule(startDirs, env),
): LeasePreflight {
  const mod = load();
  if (!mod) return SKIPPED;
  const r = mod.inspectInflightClaim(boardDir, taskId.toLowerCase(), env);
  return r.held
    ? {
        status: 'allowed',
        blocking: true,
        failing: [],
        message: 'lease-push preflight: session env, single claim and heartbeat hold',
      }
    : {
        status: 'refused',
        blocking: true,
        failing: r.failing,
        message: render(mod, r.failing, `claim of ${taskId}`),
      };
}
