/**
 * Tests for the lease-push policy checks. The filesystem fixtures need no git; the
 * lockstep tests build temp git repositories and compare against the plugin hook's
 * version. The real repository and home directory are never read.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkOwnWorktree, isProtectedBranch } from './lease-policy.js';

const require = createRequire(import.meta.url);
const hooksLib = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../ai-sdlc-plugin/hooks/lib',
);
const guard = require(path.join(hooksLib, 'lease-push-guard.js')) as {
  isProtectedBranch: (name: string, extra: string[]) => boolean;
};
const trusted = require(path.join(hooksLib, 'trusted-policy.js')) as {
  resolveLeaseWorktree: (projectDir: string, cwd: string) => unknown;
};

let tmp: string;
let savedBinding: string | undefined;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'lease-policy-')));
  // The session binding the hook reads from its own env (AISDLC-710).
  savedBinding = process.env['AI_SDLC_ACTIVE_TASK_ID'];
  process.env['AI_SDLC_ACTIVE_TASK_ID'] = 'AISDLC-9';
});
afterEach(() => {
  if (savedBinding === undefined) delete process.env['AI_SDLC_ACTIVE_TASK_ID'];
  else process.env['AI_SDLC_ACTIVE_TASK_ID'] = savedBinding;
  rmSync(tmp, { recursive: true, force: true });
});

describe('isProtectedBranch', () => {
  it('protects the defaults and the policy list, and nothing else', () => {
    for (const name of [
      'main',
      'MASTER',
      'refs/heads/main',
      'release/1.2',
      'release-please--branches--main',
      'gh-pages',
    ]) {
      expect(isProtectedBranch(name, []), name).toBe(true);
    }
    expect(isProtectedBranch('ai-sdlc/aisdlc-9-x', [])).toBe(false);
    expect(isProtectedBranch('ai-sdlc/aisdlc-9-x', ['ai-sdlc/*'])).toBe(true);
    expect(isProtectedBranch('ai-sdlc/aisdlc-9-x', ['ai-sdlc/aisdlc-9-x'])).toBe(true);
    expect(isProtectedBranch('ai-sdlc/aisdlc-9-x', ['ai-sdlc/aisdlc-8-*'])).toBe(false);
  });

  it('fails closed on an odd pattern', () => {
    expect(isProtectedBranch('anything', ['we ird'])).toBe(true);
  });

  it('agrees with the hook on every sample', () => {
    const names = [
      'main',
      'master',
      'prod',
      'production',
      'release/9',
      'releases/9',
      'gh-pages',
      'ai-sdlc/aisdlc-9',
      'ai-sdlc/aisdlc-9-slug',
      'feat/x',
      'refs/heads/ai-sdlc/aisdlc-9-slug',
      'Release/Candidate',
    ];
    const extras = [[], ['ai-sdlc/*'], ['feat/x'], ['ai-sdlc/aisdlc-9-*'], ['a b']];
    for (const extra of extras) {
      for (const name of names) {
        expect(isProtectedBranch(name, extra), `${name} ${extra.join(',')}`).toBe(
          guard.isProtectedBranch(name, extra),
        );
      }
    }
  });
});

/** A main checkout with one registered worktree, built by hand: no git involved. */
function fixture(): { main: string; wt: string; gitDir: string } {
  const main = path.join(tmp, 'main');
  const gitDir = path.join(main, '.git', 'worktrees', 'aisdlc-9');
  const wt = path.join(main, '.worktrees', 'aisdlc-9');
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(wt, '.git')}\n`);
  writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  writeFileSync(path.join(wt, '.active-task'), 'AISDLC-9\n');
  return { main, wt, gitDir };
}

/** Git runner that reports the directory it is asked about as a plain checkout. */
const plainCheckout = () => '.git';

describe('checkOwnWorktree', () => {
  it('accepts a worktree registered under the main checkout', () => {
    const { main, wt } = fixture();
    expect(checkOwnWorktree(main, wt, plainCheckout)).toBeNull();
  });

  it('refuses a worktree whose .git points somewhere else', () => {
    const { main, wt } = fixture();
    const elsewhere = path.join(tmp, 'elsewhere', 'worktrees', 'aisdlc-9');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'gitdir'), `${path.join(wt, '.git')}\n`);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${elsewhere}\n`);
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/registered/);
  });

  it('refuses a registered git dir whose back-pointer names another worktree', () => {
    const { main, wt, gitDir } = fixture();
    writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(tmp, 'other', '.git')}\n`);
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/point back/);
  });

  it('refuses a git dir whose common dir is not the main checkout', () => {
    const { main, wt, gitDir } = fixture();
    writeFileSync(path.join(gitDir, 'commondir'), '../../..\n');
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/common dir/);
  });

  it('refuses a .git that is a directory, a symlink, or has no gitdir line', () => {
    const { main, wt } = fixture();
    rmSync(path.join(wt, '.git'));
    mkdirSync(path.join(wt, '.git'));
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/plain file/);
    rmSync(path.join(wt, '.git'), { recursive: true });
    writeFileSync(path.join(tmp, 'target'), 'gitdir: x\n');
    symlinkSync(path.join(tmp, 'target'), path.join(wt, '.git'));
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/plain file/);
    rmSync(path.join(wt, '.git'));
    writeFileSync(path.join(wt, '.git'), 'nothing useful\n');
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/no gitdir line/);
  });

  it('refuses a directory that is not directly under .worktrees/', () => {
    const { main, gitDir } = fixture();
    const stray = path.join(tmp, 'stray');
    mkdirSync(stray);
    writeFileSync(path.join(stray, '.git'), `gitdir: ${gitDir}\n`);
    expect(checkOwnWorktree(main, stray, plainCheckout)).toMatch(/\.worktrees/);
    expect(checkOwnWorktree(main, main, plainCheckout)).toMatch(/\.worktrees/);
    const nested = path.join(main, '.worktrees', 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(checkOwnWorktree(main, nested, plainCheckout)).toMatch(/\.worktrees/);
  });

  it('refuses when the main checkout cannot be verified or the root is not the main checkout', () => {
    const { main, wt } = fixture();
    expect(checkOwnWorktree(main, wt, () => null)).toMatch(/cannot be verified/);
    expect(checkOwnWorktree(wt, wt, plainCheckout)).not.toBeNull();
  });

  it('refuses without a session binding or when it names another task (AISDLC-710)', () => {
    const { main, wt } = fixture();
    delete process.env['AI_SDLC_ACTIVE_TASK_ID'];
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/not bound/);
    process.env['AI_SDLC_ACTIVE_TASK_ID'] = 'AISDLC-8';
    expect(checkOwnWorktree(main, wt, plainCheckout)).toMatch(/not bound/);
    process.env['AI_SDLC_ACTIVE_TASK_ID'] = 'aisdlc-9';
    expect(checkOwnWorktree(main, wt, plainCheckout)).toBeNull();
  });

  it('refuses a worktree path that does not exist', () => {
    const { main } = fixture();
    const missing = path.join(main, '.worktrees', 'missing');
    expect(checkOwnWorktree(main, missing, plainCheckout)).not.toBeNull();
  });
});

describe('checkOwnWorktree lockstep with the hook', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });

  function realFixtures(): Record<string, { main: string; wt: string }> {
    const main = path.join(tmp, 'real-main');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-q');
    git(
      main,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    );
    const good = path.join(main, '.worktrees', 'aisdlc-1');
    git(main, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-1', good);
    writeFileSync(path.join(good, '.active-task'), 'AISDLC-1\n');

    // Forged: a directory under .worktrees/ whose .git points at the real main's .git.
    const forgedDir = path.join(main, '.worktrees', 'forged');
    mkdirSync(forgedDir, { recursive: true });
    writeFileSync(path.join(forgedDir, '.git'), `gitdir: ${path.join(main, '.git')}\n`);

    // Forged: a worktree outside .worktrees/, registered for real.
    const outside = path.join(tmp, 'outside');
    git(main, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-2', outside);

    // Forged: a git dir elsewhere that points its commondir at the real repo.
    const fakeGit = path.join(tmp, 'fake-gitdir');
    mkdirSync(fakeGit, { recursive: true });
    const redirected = path.join(main, '.worktrees', 'redirected');
    mkdirSync(redirected, { recursive: true });
    writeFileSync(path.join(redirected, '.git'), `gitdir: ${fakeGit}\n`);
    writeFileSync(path.join(fakeGit, 'gitdir'), `${path.join(redirected, '.git')}\n`);
    writeFileSync(path.join(fakeGit, 'commondir'), `${path.join(main, '.git')}\n`);

    return {
      genuine: { main, wt: good },
      forged: { main, wt: forgedDir },
      outside: { main, wt: outside },
      redirected: { main, wt: redirected },
    };
  }

  it('accepts and refuses exactly what the hook does', () => {
    process.env['AI_SDLC_ACTIVE_TASK_ID'] = 'AISDLC-1';
    for (const [label, { main, wt }] of Object.entries(realFixtures())) {
      let hookAccepts: boolean;
      try {
        hookAccepts = trusted.resolveLeaseWorktree(main, wt) !== null;
      } catch {
        hookAccepts = false;
      }
      expect(checkOwnWorktree(main, wt) === null, label).toBe(hookAccepts);
    }
  });

  it('agrees with the hook when the session is unbound or bound to another task', () => {
    const { main, wt } = realFixtures().genuine!;
    for (const binding of [undefined, '', 'AISDLC-2']) {
      if (binding === undefined) delete process.env['AI_SDLC_ACTIVE_TASK_ID'];
      else process.env['AI_SDLC_ACTIVE_TASK_ID'] = binding;
      expect(trusted.resolveLeaseWorktree(main, wt), String(binding)).toBeNull();
      expect(checkOwnWorktree(main, wt), String(binding)).not.toBeNull();
    }
  });

  it('accepts a genuine git worktree', () => {
    process.env['AI_SDLC_ACTIVE_TASK_ID'] = 'AISDLC-1';
    const { main, wt } = realFixtures().genuine!;
    expect(checkOwnWorktree(main, wt)).toBeNull();
  });
});
