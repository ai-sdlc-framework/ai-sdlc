/**
 * The install-location part of the dispatch-caller mistake guard. The caller is
 * resolved from an injected roster and process table; the checkouts are real temp
 * git repositories. The guard is not authentication: a copy of the command placed
 * inside the checkout passes this check, and only the hook-level deny for executor
 * roles closes that.
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

describe('install location', () => {
  it('passes when the command is installed inside the main checkout', () => {
    const main = initRepo(path.join(tmp, 'main'));
    for (const dir of [
      main,
      path.join(main, 'pipeline-cli'),
      path.join(main, 'node_modules', 'x'),
    ]) {
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

  it('refuses a command installed under a different repository', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const scratch = initRepo(path.join(tmp, 'scratch'));
    const check = checkDispatchCaller(inputs(main, path.join(scratch, 'pipeline-cli')));
    expect(check).toEqual({
      ok: false,
      reason: "cli-test: refused; the command is not running from the main checkout's install",
    });
  });

  it('refuses a sibling directory that only shares the checkout name as a prefix', () => {
    const main = initRepo(path.join(tmp, 'main'));
    mkdirSync(path.join(tmp, 'main-evil'));
    expect(checkDispatchCaller(inputs(main, path.join(tmp, 'main-evil')))).toMatchObject({
      ok: false,
    });
  });

  it('refuses a directory that is outside the checkout or does not exist', () => {
    const main = initRepo(path.join(tmp, 'main'));
    expect(checkDispatchCaller(inputs(main, tmp))).toMatchObject({ ok: false });
    expect(checkDispatchCaller(inputs(main, '/definitely/not/here'))).toMatchObject({ ok: false });
  });

  it('refuses when the install directory cannot be determined', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const check = checkDispatchCaller(inputs(main, null));
    expect(check).toMatchObject({ ok: false });
    expect((check as { reason: string }).reason).toContain("main checkout's install");
  });

  it('derives the default from the running module, not from cwd or the environment', () => {
    const main = initRepo(path.join(tmp, 'main'));
    const here = defaultInstallDir();
    expect(here).toBe(path.dirname(fileURLToPath(import.meta.url)));
    // This module is not inside the scratch main checkout, so the default refuses.
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
