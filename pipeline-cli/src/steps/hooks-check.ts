/**
 * Step 3 helper (AISDLC-693) — fail closed when a new worktree has no git hooks.
 *
 * Husky points `core.hooksPath` at `.husky/_`, a gitignored directory its
 * `prepare` script generates. A worktree that never ran `prepare` (dependencies
 * not installed, or installed with scripts disabled) has no such directory, and
 * git then runs no pre-commit, commit-msg or pre-push hook and says nothing. This
 * module asks git where hooks live (never assuming `.husky`), decides whether a
 * pre-push hook is EXPECTED (the main checkout has an executable one), and when
 * the worktree lacks it, repairs it once or fails with the command that fixes it.
 *
 * Repositories with no pre-push hook in the main checkout (adopters without husky)
 * pass without any command being run.
 *
 * @module steps/hooks-check
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Runner } from '../runtime/exec.js';

/** Filesystem reads the check needs; injectable so tests need no real hooks. */
export interface HooksCheckFs {
  /** True when `path` is a regular file the current user can execute. */
  isExecutableFile: (path: string) => boolean;
  exists: (path: string) => boolean;
  /** Read a file as utf-8; `null` on any failure. */
  readFile: (path: string) => string | null;
}

export const defaultHooksCheckFs: HooksCheckFs = {
  isExecutableFile: (path) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  exists: existsSync,
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
};

export interface EnsureWorktreeHooksOptions {
  runner: Runner;
  /** The repository's main checkout. */
  workDir: string;
  worktreePath: string;
  fs?: HooksCheckFs;
  /** Active Node version for the engine message. Default `process.version`. */
  activeNodeVersion?: string;
}

export interface EnsureWorktreeHooksResult {
  /**
   * `not-expected`: the main checkout has no pre-push hook, nothing was checked.
   * `present`: the worktree already had one. `repaired`: it has one after the
   * repair. `missing`: it still has none; `message` says how to generate it.
   */
  status: 'not-expected' | 'present' | 'repaired' | 'missing';
  hooksDir?: string;
  message?: string;
  /** How many times `pnpm run prepare` ran explicitly (0 or 1). */
  prepareRuns: number;
  /** How many times `pnpm install --frozen-lockfile` ran (0 or 1). */
  installRuns: number;
}

const PREPARE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;

/** Ask git for the hooks directory of the checkout at `root`; `null` when it cannot say. */
export async function resolveHooksDir(runner: Runner, root: string): Promise<string | null> {
  const r = await runner('git', ['-C', root, 'rev-parse', '--git-path', 'hooks'], {
    allowFailure: true,
  });
  const out = r.stdout.trim();
  if (r.code !== 0 || out === '') return null;
  // A relative answer (core.hooksPath = .husky/_) is relative to the checkout.
  return resolve(root, out);
}

function hasPrePush(hooksDir: string, fs: HooksCheckFs): boolean {
  return fs.isExecutableFile(join(hooksDir, 'pre-push'));
}

/** `engines.node` from `<root>/package.json`, or `null`. */
export function readRequiredNodeRange(root: string, fs: HooksCheckFs): string | null {
  const raw = fs.readFile(join(root, 'package.json'));
  if (raw === null) return null;
  try {
    const range = (JSON.parse(raw) as { engines?: { node?: unknown } }).engines?.node;
    return typeof range === 'string' && range.trim() !== '' ? range.trim() : null;
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const lines = text.trim().split('\n');
  return lines.slice(-5).join('\n');
}

/**
 * The Node requirement for the install that has to run: the active version, the
 * range the repository requires, and how to get a matching Node. An install on an
 * older Node fails with ERR_PNPM_UNSUPPORTED_ENGINE, which is what left worktrees
 * without hooks in the first place.
 */
export function formatNodeRequirement(opts: {
  activeNodeVersion: string;
  requiredRange: string | null;
}): string {
  const required = opts.requiredRange ?? 'the range in package.json "engines.node"';
  return (
    `  Active Node: ${opts.activeNodeVersion}\n` +
    `  Required:    ${required}\n` +
    `  Fix: run \`nvm install && nvm use\` (reads .nvmrc), or put a Node that satisfies ` +
    `${required} first on PATH, before installing.`
  );
}

/** The exact command that generates the hooks directory in a worktree. */
export const HOOKS_FIX_COMMAND = 'pnpm install --frozen-lockfile && pnpm run prepare';

/**
 * Verify the worktree's hooks directory holds an executable `pre-push` whenever the
 * main checkout's does. When the hook is missing: without a `node_modules` directory
 * (a fresh worktree) it runs `pnpm install --frozen-lockfile` once, with install
 * scripts ENABLED so husky's `prepare` generates the hooks; then, if the hook is
 * still missing and dependencies are present, it runs `pnpm run prepare` once.
 * Never throws on a missing hook; the caller decides. Every `missing` message names
 * the hooks directory, the exact fix command and the Node requirement, plus the
 * install or prepare output when one failed (an engine failure shows up there).
 */
export async function ensureWorktreeHooks(
  opts: EnsureWorktreeHooksOptions,
): Promise<EnsureWorktreeHooksResult> {
  const { runner, workDir, worktreePath } = opts;
  const fs = opts.fs ?? defaultHooksCheckFs;

  const mainHooksDir = await resolveHooksDir(runner, workDir);
  if (mainHooksDir === null || !hasPrePush(mainHooksDir, fs)) {
    return { status: 'not-expected', prepareRuns: 0, installRuns: 0 };
  }

  let hooksDir = await resolveHooksDir(runner, worktreePath);
  if (hooksDir !== null && hasPrePush(hooksDir, fs)) {
    return { status: 'present', hooksDir, prepareRuns: 0, installRuns: 0 };
  }

  let prepareRuns = 0;
  let installRuns = 0;
  const missing = (detail: string): EnsureWorktreeHooksResult => ({
    status: 'missing',
    hooksDir: hooksDir ?? undefined,
    prepareRuns,
    installRuns,
    message:
      `Git hooks are missing in worktree ${worktreePath}: hooks directory ` +
      `${hooksDir ?? '(git could not resolve it)'} has no executable pre-push, so no ` +
      `commit or push gate would run. The main checkout has one at ${mainHooksDir}.\n` +
      `${detail}\n` +
      `Generate it with: cd ${worktreePath} && ${HOOKS_FIX_COMMAND}\n` +
      formatNodeRequirement({
        activeNodeVersion: opts.activeNodeVersion ?? process.version,
        requiredRange: readRequiredNodeRange(workDir, fs),
      }),
  });

  if (!fs.exists(join(worktreePath, 'node_modules'))) {
    installRuns = 1;
    const install = await runner('pnpm', ['install', '--frozen-lockfile'], {
      cwd: worktreePath,
      timeout: INSTALL_TIMEOUT_MS,
      allowFailure: true,
    });
    hooksDir = await resolveHooksDir(runner, worktreePath);
    if (hooksDir !== null && hasPrePush(hooksDir, fs)) {
      return { status: 'repaired', hooksDir, prepareRuns, installRuns };
    }
    if (install.code !== 0 || !fs.exists(join(worktreePath, 'node_modules'))) {
      return missing(
        `\`pnpm install --frozen-lockfile\` ${install.code !== 0 ? 'failed' : 'left no node_modules'}:\n` +
          tail(`${install.stdout}\n${install.stderr}`),
      );
    }
  }

  prepareRuns = 1;
  const prepare = await runner('pnpm', ['run', 'prepare'], {
    cwd: worktreePath,
    timeout: PREPARE_TIMEOUT_MS,
    allowFailure: true,
  });
  hooksDir = await resolveHooksDir(runner, worktreePath);
  if (hooksDir !== null && hasPrePush(hooksDir, fs)) {
    return { status: 'repaired', hooksDir, prepareRuns, installRuns };
  }
  return missing(
    prepare.code !== 0
      ? `\`pnpm run prepare\` failed:\n${tail(`${prepare.stdout}\n${prepare.stderr}`)}`
      : '`pnpm run prepare` ran but did not create it.',
  );
}
