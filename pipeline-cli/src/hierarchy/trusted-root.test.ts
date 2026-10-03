/**
 * Lockstep test: the TypeScript port of `verifiedMainRoot` must agree with the
 * plugin hook's version on the same fixture repositories. Fixtures are temp git
 * repositories created here; the real repository and home directory are never read.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mainCheckoutRoot, trustedPolicyRoot, verifiedMainRoot } from './trusted-root.js';

const require = createRequire(import.meta.url);
const hookLib = require(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../ai-sdlc-plugin/hooks/lib/trusted-policy.js',
  ),
) as {
  mainCheckoutRoot: (dir: string, run?: unknown) => string | null;
  verifiedMainRoot: (dir: string, run?: unknown) => string | null;
};

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'trusted-root-')));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  return dir;
}

/** Every fixture directory paired with a label, built fresh per test. */
function fixtures(): Record<string, string> {
  const main = initRepo(path.join(tmp, 'main'));
  const wt = path.join(main, '.worktrees', 'aisdlc-1');
  git(main, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-1', wt);
  const sub = path.join(main, 'pkg');
  mkdirSync(sub);

  // A forged repo: its .git is a file pointing at the real repo's gitdir.
  const forged = path.join(tmp, 'forged');
  mkdirSync(forged);
  writeFileSync(path.join(forged, '.git'), `gitdir: ${path.join(main, '.git')}\n`);

  // A repo whose .git is a symlink to another repo's .git directory.
  const real = initRepo(path.join(tmp, 'real'));
  const linked = path.join(tmp, 'linked');
  mkdirSync(linked);
  symlinkSync(path.join(real, '.git'), path.join(linked, '.git'));

  // A bare repository, and a directory that is not a repository at all.
  const bare = path.join(tmp, 'bare.git');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  const plain = path.join(tmp, 'plain');
  mkdirSync(plain);

  return { main, worktree: wt, subdir: sub, forged, symlinkedGit: linked, bare, plain };
}

describe('verifiedMainRoot lockstep with the hook', () => {
  it('agrees with the hook on every fixture', () => {
    for (const [label, dir] of Object.entries(fixtures())) {
      expect(verifiedMainRoot(dir), label).toBe(hookLib.verifiedMainRoot(dir));
      expect(mainCheckoutRoot(dir), label).toBe(hookLib.mainCheckoutRoot(dir));
    }
  });

  it('resolves the main checkout from the main checkout, a subdirectory and a worktree', () => {
    const f = fixtures();
    for (const dir of [f.main!, f.subdir!, f.worktree!]) {
      expect(realpathSync(verifiedMainRoot(dir) as string)).toBe(f.main);
    }
  });

  it('fails closed on a symlinked .git, a forged .git file, a bare repo and a non-repo', () => {
    const f = fixtures();
    for (const label of ['symlinkedGit', 'bare', 'plain']) {
      expect(verifiedMainRoot(f[label]!), label).toBeNull();
      expect(hookLib.verifiedMainRoot(f[label]!), label).toBeNull();
    }
    // A forged repo resolves to the repo it points at only if the common dir checks pass;
    // whatever it yields must equal the hook's answer and never a path outside a real .git dir.
    expect(verifiedMainRoot(f.forged!)).toBe(hookLib.verifiedMainRoot(f.forged!));
  });

  it('agrees with the hook with an injected runner that lies or fails', () => {
    const f = fixtures();
    const runners: Array<(args: readonly string[], cwd: string) => string | null> = [
      () => null,
      () => '/elsewhere/repo.git',
      () => '.git',
      () => path.join(f.main!, '.git'),
    ];
    for (const run of runners) {
      expect(verifiedMainRoot(f.worktree!, run)).toBe(hookLib.verifiedMainRoot(f.worktree!, run));
      expect(mainCheckoutRoot(f.worktree!, run)).toBe(hookLib.mainCheckoutRoot(f.worktree!, run));
    }
  });
});

describe('trustedPolicyRoot', () => {
  it('requires project dir and cwd to verify and to be the same checkout', () => {
    const f = fixtures();
    expect(realpathSync(trustedPolicyRoot(f.worktree!, f.main!) as string)).toBe(f.main);
    expect(trustedPolicyRoot(f.main!, f.plain!)).toBeNull();
    expect(trustedPolicyRoot(f.plain!, f.main!)).toBeNull();
    expect(trustedPolicyRoot(f.main!, f.symlinkedGit!)).toBeNull();
    const other = initRepo(path.join(tmp, 'other'));
    expect(trustedPolicyRoot(f.main!, other)).toBeNull();
  });
});
