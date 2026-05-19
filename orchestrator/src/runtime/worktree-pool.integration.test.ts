/**
 * Integration test: safe/non-flaky worktree operations against a real git repo.
 * Per RFC-0010 §17 Phase 2 acceptance criterion.
 *
 * Uses a real `git` binary so the .git pointer file format and worktree mechanics are
 * exercised end-to-end. Skipped automatically if git is unavailable.
 *
 * The 3-worktree parallel-allocate test (FLAKY: git worktree write-then-read race on
 * CI under load, AISDLC-368) has been moved to worktree-pool.integration.flaky.test.ts
 * and is exercised by the nightly flaky-tests.yml workflow.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreePoolManager } from './worktree-pool.js';
import { makeGitEnv } from '../__test-helpers/git-env.js';

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('WorktreePoolManager integration (real git)', () => {
  let hasGit = false;
  let tmpRoot: string;
  let cloneDir: string;
  let poolDir: string;

  beforeAll(async () => {
    hasGit = await gitAvailable();
  });

  beforeEach(async () => {
    if (!hasGit) return;
    tmpRoot = await mkdtemp(join(tmpdir(), 'pool-int-'));
    cloneDir = join(tmpRoot, 'clone');
    poolDir = join(tmpRoot, 'pool');
    await mkdir(cloneDir, { recursive: true });

    // Initialize a real git repo with main branch + initial commit.
    // makeGitEnv() (AISDLC-257) constructs a minimal env that deliberately
    // omits GIT_DIR + GIT_WORK_TREE so these commands always bind to cloneDir's
    // own .git, not a parent worktree's context inherited from a husky hook.
    // Identity is provided via GIT_AUTHOR_* / GIT_COMMITTER_* so we don't
    // need `git config user.email` writes (which could land in the wrong
    // .git/config if GIT_DIR was polluted).
    const env = makeGitEnv();
    await execFileAsync('git', ['init', '-b', 'main', cloneDir], { env });
    await writeFile(join(cloneDir, 'README.md'), '# fixture\n');
    await execFileAsync('git', ['add', '.'], { cwd: cloneDir, env });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: cloneDir, env });
  });

  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  // Flaky test moved to worktree-pool.integration.flaky.test.ts (AISDLC-371).
  // The 3-worktree parallel-allocate test exhibits a git worktree write-then-read
  // race on CI under load and is exercised by the nightly flaky-tests.yml instead.

  it('refuses to reclaim a worktree with uncommitted changes (safety property)', async () => {
    if (!hasGit) return;
    const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir });
    const handle = await pool.allocate('feat/dirty', { baseBranch: 'main' });
    await writeFile(join(handle.path, 'new-file.ts'), 'export const x = 1;\n');

    await expect(pool.reclaim('feat/dirty')).rejects.toThrow(/uncommitted changes/);
    // Force flag overrides the safety check.
    await pool.reclaim('feat/dirty', { force: true });
    expect(await pool.list()).toEqual([]);
  });

  it('adopts an existing worktree (created=false) on second allocate of the same branch', async () => {
    if (!hasGit) return;
    const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir });
    const first = await pool.allocate('feat/repeat', { baseBranch: 'main' });
    const second = await pool.allocate('feat/repeat');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    await pool.reclaim('feat/repeat');
  });
});
