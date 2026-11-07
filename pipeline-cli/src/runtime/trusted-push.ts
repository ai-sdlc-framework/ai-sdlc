/**
 * Trusted pipeline push (AISDLC-731).
 *
 * The pipeline pushes a task branch from a worktree whose files (`.husky/`,
 * `.git/hooks/`, repo config) an untrusted run may have shaped. A bare `git push`
 * would run those hooks and honour that config with the operator's credentials.
 * Every pipeline push is therefore built by `buildTrustedPush`, the ONE function that
 * decides what the push may inherit from the worktree:
 *
 *  - `-c core.hooksPath=<main checkout>/.husky/_`: hooks come from the main checkout,
 *    never the worktree's `.husky/` or `.git/hooks/`.
 *  - `-c core.sshCommand=<operator value>`, `-c core.fsmonitor=false`,
 *    `-c protocol.ext.allow=never`: scalar keys that execute a program are pinned on the
 *    command line, which outranks every config file.
 *  - `url.*.insteadOf` / `pushInsteadOf` are multi-valued, so they cannot be unset by
 *    `-c`. Instead the raw remote URL is pinned with a rewrite of itself, which wins
 *    git's longest-prefix match; `resolveTrustedPushInputs` verifies the effective push
 *    URL equals the raw one and refuses the push otherwise.
 *
 * Environment handling (AISDLC-1129): `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
 * `GIT_PREFIX` are UNSET for the push child (an `undefined` env value drops the key), so a
 * leaked value cannot redirect the push to another repository; the push is addressed by
 * `cwd` (the task worktree) alone.
 *
 * @module runtime/trusted-push
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ExecOptions, ExecResult, Runner } from './exec.js';

const SCRUBBED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX'] as const;

export interface TrustedPushInputs {
  /** Main checkout (trusted, read-only to a run); its `.husky/_` supplies the hooks. */
  mainCheckout: string;
  /** Raw remote URL (before any rewrite), or null when unknown. */
  remoteUrl?: string | null;
  /** Operator's `core.sshCommand` (global scope), default `ssh`. */
  sshCommand?: string;
}

export interface TrustedPush {
  /** Full git argv: `-c` overrides followed by the push arguments. */
  args: string[];
  /** Env overrides: the scrubbed `GIT_*` keys set to undefined. */
  env: NodeJS.ProcessEnv;
}

/** Pure builder: the single place the push-time config overrides are listed. */
export function buildTrustedPush(inputs: TrustedPushInputs, pushArgs: string[]): TrustedPush {
  const overrides: string[] = [
    `core.hooksPath=${join(inputs.mainCheckout, '.husky', '_')}`,
    `core.sshCommand=${inputs.sshCommand ?? 'ssh'}`,
    'core.fsmonitor=false',
    'protocol.ext.allow=never',
  ];
  if (inputs.remoteUrl) {
    overrides.push(
      `url.${inputs.remoteUrl}.insteadOf=${inputs.remoteUrl}`,
      `url.${inputs.remoteUrl}.pushInsteadOf=${inputs.remoteUrl}`,
    );
  }
  const env: NodeJS.ProcessEnv = {};
  for (const k of SCRUBBED_GIT_ENV) env[k] = undefined;
  return { args: [...overrides.flatMap((o) => ['-c', o]), ...pushArgs], env };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !(SCRUBBED_GIT_ENV as readonly string[]).includes(k),
        ),
      ),
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the raw remote URL and operator ssh command. Returns `refusal` when the effective
 * push URL still differs from the raw one after the pin (a tie with a planted rewrite).
 */
export function resolveTrustedPushInputs(
  mainCheckout: string,
  worktree: string,
): TrustedPushInputs & { refusal?: string } {
  const raw =
    git(worktree, ['config', '--get', 'remote.origin.pushurl']) ||
    git(worktree, ['config', '--get', 'remote.origin.url']);
  const ssh = git(worktree, ['config', '--global', '--get', 'core.sshCommand']);
  const inputs: TrustedPushInputs = {
    mainCheckout,
    remoteUrl: raw || null,
    ...(ssh ? { sshCommand: ssh } : {}),
  };
  if (!raw) return inputs;
  const probe = buildTrustedPush(inputs, ['remote', 'get-url', '--push', 'origin']);
  const effective = git(worktree, probe.args);
  if (effective !== null && effective !== raw) {
    return {
      ...inputs,
      refusal: `push refused: a url.*.insteadOf rewrite in the worktree git config redirects origin (${raw} -> ${effective})`,
    };
  }
  return inputs;
}

/** Run a pipeline `git push` through the trusted builder. `pushArgs` starts with `push`. */
export async function runTrustedPush(
  runner: Runner,
  where: { mainCheckout: string; worktree: string },
  pushArgs: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const inputs = resolveTrustedPushInputs(where.mainCheckout, where.worktree);
  if (inputs.refusal) return { code: 1, stdout: '', stderr: inputs.refusal };
  const built = buildTrustedPush(inputs, pushArgs);
  return runner('git', built.args, {
    ...opts,
    cwd: where.worktree,
    env: { ...opts.env, ...built.env },
  });
}
