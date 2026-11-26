/**
 * Knowledge-log principal (AISDLC-1420): who acted on an event, next to the
 * `by` role. Audit only; no authority rule reads it.
 *
 *   human                      -> human:<git user.email | $USER>
 *   agent in a roster session  -> agent:<session name>
 *   agent with an active task  -> agent:task:<AI_SDLC_ACTIVE_TASK_ID>
 *   otherwise                  -> agent:unknown
 */
import { join } from 'node:path';
import process from 'node:process';
import {
  createSystemIdentity,
  resolveCaller,
  type CallerIdentity,
} from '../hierarchy/caller-identity.js';
import { gitUserEmail, resolveOperatorIdentity } from '../util/operator-identity.js';
import type { Role } from './promote.js';

export interface PrincipalDeps {
  role: Role;
  /** git `user.email`, or '' when unset. */
  gitEmail: () => string;
  /** The calling roster session, or null. */
  caller: () => CallerIdentity | null;
}

/** Never throws: any lookup failure degrades to the next source. */
export function resolveKnowledgePrincipal(env: NodeJS.ProcessEnv, deps: PrincipalDeps): string {
  if (deps.role === 'human') {
    return `human:${resolveOperatorIdentity(undefined, env, deps.gitEmail)}`;
  }
  let caller: CallerIdentity | null;
  try {
    caller = deps.caller();
  } catch {
    caller = null;
  }
  if (caller?.name) return `agent:${caller.name}`;
  const task = env.AI_SDLC_ACTIVE_TASK_ID?.trim();
  if (task) return `agent:task:${task}`;
  return 'agent:unknown';
}

/** Production dependencies: real git and the roster of the project's dispatch board. */
export function systemPrincipalDeps(
  role: Role,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PrincipalDeps {
  const boardDir = env.AI_SDLC_DISPATCH_BOARD_DIR ?? join(projectDir, '.ai-sdlc', 'dispatch');
  return {
    role,
    gitEmail: gitUserEmail,
    caller: () => resolveCaller(createSystemIdentity(boardDir)),
  };
}
