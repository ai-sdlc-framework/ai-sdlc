/**
 * Operator identity: the git `user.email`, falling back to `$USER`, then
 * `unknown`. Shared by `cli-capture` and the knowledge-log principal (AISDLC-1420).
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** `git config user.email`, or '' when git is missing or the value is unset. */
export function gitUserEmail(): string {
  const r = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: 'pipe' });
  return r.stdout?.trim() ?? '';
}

/**
 * The override when given, else the git email, else `$USER`, else `unknown`.
 * `gitEmail` is injected so tests never spawn git; a throwing lookup counts as unset.
 */
export function resolveOperatorIdentity(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  gitEmail: () => string = gitUserEmail,
): string {
  if (override) return override;
  let email = '';
  try {
    email = gitEmail();
  } catch {
    // fall through to $USER
  }
  return email || env.USER || 'unknown';
}
