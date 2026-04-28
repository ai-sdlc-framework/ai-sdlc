/**
 * Regression test for AISDLC-72.
 *
 * Reproduces the AISDLC-68 surface story: when a parent process exports
 * GIT_DIR pointing at SOME OTHER repo, naive `execSync('git ...', { cwd })`
 * resolves against the leaked GIT_DIR rather than `cwd`'s own .git. The
 * cleanGitEnv() helper strips the env vars so subprocess git operations
 * bind to `cwd` correctly.
 *
 * The test deliberately invokes a temp-repo `git init` + `git commit`
 * sequence with a bogus GIT_DIR set in process.env and asserts the
 * temp-repo operation succeeds and writes its commit into the temp repo
 * (not into the bogus GIT_DIR).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnv, gitExecFile } from './git-env.js';

const execFileAsync = promisify(execFile);

describe('cleanGitEnv', () => {
  it('returns a copy of process.env without git context vars', () => {
    const prev = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      PATH: process.env.PATH,
    };
    process.env.GIT_DIR = '/tmp/fake-git-dir';
    process.env.GIT_WORK_TREE = '/tmp/fake-work-tree';
    process.env.GIT_INDEX_FILE = '/tmp/fake-git-dir/index';
    try {
      const env = cleanGitEnv();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      // Other env vars should still be present.
      expect(env.PATH).toBe(prev.PATH);
      // process.env itself is unchanged (we only return a copy).
      expect(process.env.GIT_DIR).toBe('/tmp/fake-git-dir');
    } finally {
      if (prev.GIT_DIR === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev.GIT_DIR;
      if (prev.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = prev.GIT_WORK_TREE;
      if (prev.GIT_INDEX_FILE === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prev.GIT_INDEX_FILE;
    }
  });

  it('returns a fresh object — mutating it does not affect process.env', () => {
    const env = cleanGitEnv();
    env.MY_NEW_VAR = 'mutated';
    expect(process.env.MY_NEW_VAR).toBeUndefined();
  });
});

describe('gitExecFile (regression: AISDLC-72)', () => {
  let tmpRoot: string;
  let repo: string;
  let bogusGitDir: string;
  const savedGitDir = process.env.GIT_DIR;
  const savedGitWorkTree = process.env.GIT_WORK_TREE;
  const savedGitIndexFile = process.env.GIT_INDEX_FILE;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'git-env-test-'));
    repo = join(tmpRoot, 'repo');
    bogusGitDir = join(tmpRoot, 'bogus-parent-git-dir');
    await mkdir(repo, { recursive: true });
    // Set a bogus GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the env to
    // simulate the husky pre-push hook scenario. The path doesn't exist,
    // so naive `execFile('git', ...)` would fail loudly — proving the
    // helper actually strips the leaked env.
    process.env.GIT_DIR = bogusGitDir;
    process.env.GIT_WORK_TREE = tmpRoot;
    process.env.GIT_INDEX_FILE = join(bogusGitDir, 'index');
  });

  afterEach(async () => {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = savedGitWorkTree;
    if (savedGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = savedGitIndexFile;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('temp-repo git init+commit succeeds despite bogus GIT_DIR in env', async () => {
    // Sanity check: with leaked GIT_DIR, naive execFile fails because
    // GIT_DIR points at a path that doesn't exist.
    await expect(execFileAsync('git', ['status'], { cwd: repo })).rejects.toThrow();

    // Same op via gitExecFile() should succeed because it strips GIT_DIR.
    await gitExecFile(['init', '-q', '-b', 'main'], { cwd: repo });
    await gitExecFile(['config', 'user.email', 'test@test.com'], { cwd: repo });
    await gitExecFile(['config', 'user.name', 'test'], { cwd: repo });
    await writeFile(join(repo, 'a.md'), 'hello\n');
    await gitExecFile(['add', 'a.md'], { cwd: repo });
    await gitExecFile(['commit', '-q', '-m', 'init'], { cwd: repo });

    // Verify: commit landed in the TEMP repo (not the bogus GIT_DIR).
    const { stdout: log } = await gitExecFile(['log', '--format=%s'], { cwd: repo });
    expect(log.trim()).toBe('init');

    // Verify: bogus GIT_DIR was never created (no leak into the would-be
    // parent repo location).
    expect(existsSync(bogusGitDir)).toBe(false);
  });

  it('temp-repo write does not contaminate the leaked-GIT_DIR location', async () => {
    await gitExecFile(['init', '-q', '-b', 'main'], { cwd: repo });
    await gitExecFile(['config', 'user.email', 'test@test.com'], { cwd: repo });
    await gitExecFile(['config', 'user.name', 'test'], { cwd: repo });
    await writeFile(join(repo, 'b.md'), 'world\n');
    await gitExecFile(['add', 'b.md'], { cwd: repo });
    await gitExecFile(['commit', '-q', '-m', 'world'], { cwd: repo });

    // The leaked GIT_DIR path should still NOT exist — proving the commit
    // didn't accidentally write its index there.
    expect(existsSync(bogusGitDir)).toBe(false);

    // The repo's own .git/HEAD should reference the new commit, confirming
    // the operation bound to the right directory.
    const headRef = await readFile(join(repo, '.git', 'HEAD'), 'utf-8');
    expect(headRef).toMatch(/^ref: refs\/heads\/main/);
  });

  it('respects caller-supplied env (does not silently override)', async () => {
    // Initialize the repo first using the helper.
    await gitExecFile(['init', '-q', '-b', 'main'], { cwd: repo });
    await gitExecFile(['config', 'user.email', 'test@test.com'], { cwd: repo });
    await gitExecFile(['config', 'user.name', 'test'], { cwd: repo });

    // If the caller passes their own env that includes GIT_DIR, gitExecFile
    // should respect it (caller knows what they're doing). Set it to the
    // repo's actual git dir to verify the call still works.
    const customEnv: NodeJS.ProcessEnv = { ...process.env };
    customEnv.GIT_DIR = join(repo, '.git');
    customEnv.GIT_WORK_TREE = repo;
    delete customEnv.GIT_INDEX_FILE;

    const { stdout } = await gitExecFile(['rev-parse', '--show-toplevel'], {
      cwd: repo,
      env: customEnv,
    });
    // macOS resolves /var → /private/var via symlink, so compare realpaths.
    expect(await realpath(stdout.trim())).toBe(await realpath(repo));
  });
});
