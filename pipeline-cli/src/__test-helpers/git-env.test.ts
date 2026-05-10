/**
 * Regression test for AISDLC-253 — fixture leak prevention.
 *
 * The leak: when checkpoint.test.ts ran with the parent shell exporting
 * GIT_DIR=/path/to/host/worktree/.git (e.g. inherited from a husky pre-push
 * hook), `execSync('git init', { cwd: tmpdir })` created `.git/` in tmpdir
 * BUT every subsequent `git config` / `git add` / `git commit` followed the
 * polluted GIT_DIR, writing into the HOST worktree's branch — wiping its
 * tree on commit.
 *
 * The fix: `makeGitEnv()` returns an env object that DELIBERATELY OMITS
 * GIT_DIR + GIT_WORK_TREE keys (omission in the env arg of execSync REPLACES
 * the parent's env, it doesn't merge), so child processes can never inherit
 * those vars from the parent shell.
 *
 * This test asserts the contract: makeGitEnv() never includes GIT_DIR /
 * GIT_WORK_TREE in its returned object, even when those vars exist in
 * process.env.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { makeGitEnv } from './git-env.js';

describe('makeGitEnv() — AISDLC-253 fixture-leak prevention', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore process.env so a polluted setup doesn't bleed into other tests.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('never includes GIT_DIR even if process.env has it', () => {
    process.env['GIT_DIR'] = '/tmp/polluted-git-dir';
    const env = makeGitEnv();
    expect(env['GIT_DIR']).toBeUndefined();
    expect(Object.keys(env)).not.toContain('GIT_DIR');
  });

  it('never includes GIT_WORK_TREE even if process.env has it', () => {
    process.env['GIT_WORK_TREE'] = '/tmp/polluted-worktree';
    const env = makeGitEnv();
    expect(env['GIT_WORK_TREE']).toBeUndefined();
    expect(Object.keys(env)).not.toContain('GIT_WORK_TREE');
  });

  it('disables system + global git config', () => {
    const env = makeGitEnv();
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  });

  it('disables husky', () => {
    const env = makeGitEnv();
    expect(env['HUSKY']).toBe('0');
  });

  it('provides identity via GIT_AUTHOR_* / GIT_COMMITTER_* (no need for git config user.email)', () => {
    const env = makeGitEnv();
    expect(env['GIT_AUTHOR_NAME']).toBe('Test');
    expect(env['GIT_AUTHOR_EMAIL']).toBe('test@test.invalid');
    expect(env['GIT_COMMITTER_NAME']).toBe('Test');
    expect(env['GIT_COMMITTER_EMAIL']).toBe('test@test.invalid');
  });

  it('preserves PATH so git binary is findable', () => {
    const env = makeGitEnv();
    expect(env['PATH']).toBeDefined();
    expect(env['PATH']!.length).toBeGreaterThan(0);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = makeGitEnv();
    const b = makeGitEnv();
    expect(a).not.toBe(b); // different references
    expect(a).toEqual(b); // same content
    a['GIT_AUTHOR_NAME'] = 'mutated';
    expect(b['GIT_AUTHOR_NAME']).toBe('Test'); // mutation doesn't bleed
  });
});
