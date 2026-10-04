/**
 * The install-location part of the dispatch-caller mistake guard. The caller is
 * resolved from an injected roster and process table; the checkouts are real temp
 * git repositories. The guard is not authentication: a copy of the command placed
 * inside the checkout passes this check, an installed layout that is in no work tree
 * (global install, plugin cache) skips it, and only the hook-level deny for executor
 * roles closes those.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdentityDeps } from './caller-identity.js';
import { checkDispatchCaller, defaultInstallDir } from './dispatch-caller.js';
import { stripGitRedirects } from './git-env.js';
import { resolveTrustedBoard } from './trusted-root.js';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dispatch-caller-')));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gitEnv = {
  ...stripGitRedirects(process.env),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitEnv });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  return dir;
}

const dispatch: IdentityDeps = {
  readSessions: () => [
    { name: 'operator-dispatch', role: 'operator-dispatch', pid: 400, status: 'running' },
  ],
  parentPid: (pid) => (pid === 500 ? 400 : null),
  comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
  startPid: 500,
};

function inputs(main: string, installDir?: string | null) {
  const trusted = resolveTrustedBoard(main)!;
  return {
    label: 'cli-test',
    cwd: main,
    boardDir: trusted.boardDir,
    identity: dispatch,
    trustedBoard: trusted,
    ...(installDir === undefined ? {} : { installDir }),
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv });

/** An install directory that exists, created on demand. */
const dirAt = (...parts: string[]): string => {
  const dir = path.join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('install location', () => {
  it('passes when the command is installed inside the main checkout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    for (const dir of [main, dirAt(main, 'pipeline-cli'), dirAt(main, 'node_modules', 'x')]) {
      expect(checkDispatchCaller(inputs(main, dir)), dir).toEqual({
        ok: true,
        name: 'operator-dispatch',
      });
    }
  });

  it('passes through a symlink that resolves inside the main checkout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    mkdirSync(path.join(main, 'cli'));
    symlinkSync(path.join(main, 'cli'), path.join(tmp, 'link'));
    expect(checkDispatchCaller(inputs(main, path.join(tmp, 'link')))).toMatchObject({ ok: true });
  });

  it('refuses a copy of the command inside a task worktree of the main checkout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const wt = path.join(main, '.worktrees', 'aisdlc-9');
    git(main, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-9', wt);
    const check = checkDispatchCaller(inputs(main, dirAt(wt, 'pipeline-cli')));
    expect(check).toEqual({
      ok: false,
      reason: "cli-test: refused; the command is not running from the main checkout's install",
    });
  });

  it('refuses a command installed inside a different repository', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const scratch = initRepo(path.join(tmp, 'scratch'));
    expect(checkDispatchCaller(inputs(main, dirAt(scratch, 'pipeline-cli')))).toMatchObject({
      ok: false,
    });
  });

  it('refuses a sibling repository whose name only shares a prefix with the checkout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const evil = initRepo(path.join(tmp, 'main-evil'));
    expect(checkDispatchCaller(inputs(main, dirAt(evil, 'cli')))).toMatchObject({ ok: false });
  });

  it('skips the check for a global-install-like directory that is in no work tree', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const dir = dirAt(tmp, 'global', 'lib', 'node_modules', '@ai-sdlc', 'pipeline-cli');
    expect(checkDispatchCaller(inputs(main, dir))).toEqual({
      ok: true,
      name: 'operator-dispatch',
    });
  });

  it('skips the check for a plugin-cache-like directory that is in no work tree', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const dir = dirAt(tmp, 'plugins', 'cache', 'x', 'pipeline-cli');
    expect(checkDispatchCaller(inputs(main, dir))).toMatchObject({ ok: true });
  });

  it('still applies every other check to an installed layout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const dir = dirAt(tmp, 'plugins', 'cache', 'x', 'pipeline-cli');
    const wrongBoard = { ...inputs(main, dir), boardDir: path.join(tmp, 'elsewhere') };
    expect(checkDispatchCaller(wrongBoard)).toMatchObject({ ok: false });
    const executor: IdentityDeps = {
      ...dispatch,
      readSessions: () => [{ name: 'e', role: 'executor', pid: 400, status: 'running' }],
    };
    expect(checkDispatchCaller({ ...inputs(main, dir), identity: executor })).toMatchObject({
      ok: false,
    });
  });

  it('refuses when the install directory cannot be determined or resolved', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const reason = "cli-test: refused; the command is not running from the main checkout's install";
    expect(checkDispatchCaller(inputs(main, null))).toEqual({ ok: false, reason });
    expect(checkDispatchCaller(inputs(main, '/definitely/not/here'))).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses when git fails for any reason other than "not a repository"', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const dir = dirAt(tmp, 'plugins', 'cache', 'y');
    const failing = (status: number | null, stderr: string) => ({
      ...inputs(main, dir),
      installGit: () => ({ status, stdout: '', stderr }),
    });
    expect(checkDispatchCaller(failing(128, 'fatal: detected dubious ownership'))).toMatchObject({
      ok: false,
    });
    expect(checkDispatchCaller(failing(1, 'boom'))).toMatchObject({ ok: false });
    expect(checkDispatchCaller(failing(null, ''))).toMatchObject({ ok: false });
    expect(
      checkDispatchCaller(failing(128, 'fatal: not a git repository (or any parent): .git')),
    ).toMatchObject({ ok: true });
  });

  it('derives the default from the running module, not from cwd or the environment', () => {
    const main = initRepo(path.join(tmp, 'main'));
    expect(defaultInstallDir()).toBe(path.dirname(fileURLToPath(import.meta.url)));
    // This module is inside the repository the tests run from, not the scratch main
    // checkout, so the default refuses.
    expect(checkDispatchCaller(inputs(main))).toMatchObject({ ok: false });
    const saved = process.env.AI_SDLC_PROJECT_ROOT;
    process.env.AI_SDLC_PROJECT_ROOT = main;
    try {
      expect(checkDispatchCaller(inputs(main))).toMatchObject({ ok: false });
    } finally {
      if (saved === undefined) delete process.env.AI_SDLC_PROJECT_ROOT;
      else process.env.AI_SDLC_PROJECT_ROOT = saved;
    }
  });
});
