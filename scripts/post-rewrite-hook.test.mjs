// AISDLC-708: hermetic reproduction + regression tests for .husky/post-rewrite.
//
// Root cause: the hook ran `git update-ref refs/heads/main origin/main` in the
// parent, which has main checked out. That moves HEAD alone; the index and
// working tree stay at the old commit, so `git status` shows every path between
// old and new main as a staged change.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.husky', 'post-rewrite');

function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts }).trim();
}

function commit(repo, file, content, msg) {
  writeFileSync(join(repo, file), content);
  sh(`git -C "${repo}" add "${file}" && git -C "${repo}" commit -q -m "${msg}"`);
}

describe('.husky/post-rewrite (AISDLC-708)', () => {
  let root, parent, wt, remote, clone;

  function setup(parentBranch) {
    root = mkdtempSync(join(tmpdir(), 'ai-sdlc-post-rewrite-'));
    remote = join(root, 'remote.git');
    parent = join(root, 'parent');
    wt = join(root, 'wt');
    clone = join(root, 'clone');
    sh(`git init -q --bare -b main "${remote}"`);
    sh(`git init -q -b main "${parent}"`);
    sh(`git -C "${parent}" config user.email t@t.t && git -C "${parent}" config user.name t`);
    sh(`git -C "${parent}" config commit.gpgsign false`);
    commit(parent, 'a.txt', '1\n', 'initial');
    sh(
      `git -C "${parent}" remote add origin "${remote}" && git -C "${parent}" push -q -u origin main`,
    );
    sh(`git -C "${parent}" worktree add -q -b feat "${wt}"`);
    // origin advances.
    sh(`git clone -q "${remote}" "${clone}"`);
    sh(`git -C "${clone}" config user.email c@c.c && git -C "${clone}" config user.name c`);
    sh(`git -C "${clone}" config commit.gpgsign false`);
    commit(clone, 'a.txt', '2\n', 'advance');
    sh(`git -C "${clone}" push -q origin main`);
    sh(`git -C "${parent}" fetch -q origin main`);
    if (parentBranch !== 'main') sh(`git -C "${parent}" checkout -q -b other`);
  }

  function runHook() {
    return execFileSync('bash', [HOOK, 'rebase'], { cwd: wt, encoding: 'utf8' });
  }

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('AISDLC-708 reproduction: never leaves a main-checked-out parent with HEAD ahead of index/tree', () => {
    setup('main');
    const before = sh(`git -C "${parent}" rev-parse HEAD`);
    runHook();
    assert.equal(sh(`git -C "${parent}" status --porcelain`), '', 'parent index/tree diverged');
    assert.equal(sh(`git -C "${parent}" rev-parse HEAD`), before, 'hook must not move HEAD alone');
  });

  it('fast-forwards main when the parent is on another branch', () => {
    setup('other');
    runHook();
    assert.equal(
      sh(`git -C "${parent}" rev-parse refs/heads/main`),
      sh(`git -C "${parent}" rev-parse refs/remotes/origin/main`),
    );
  });

  it('refuses a non-fast-forward main update', () => {
    setup('other');
    // Local main diverges from origin/main.
    sh(`git -C "${parent}" checkout -q main`);
    commit(parent, 'local.txt', 'x\n', 'local-only');
    sh(`git -C "${parent}" checkout -q other`);
    const before = sh(`git -C "${parent}" rev-parse refs/heads/main`);
    runHook();
    assert.equal(sh(`git -C "${parent}" rev-parse refs/heads/main`), before);
  });
});
