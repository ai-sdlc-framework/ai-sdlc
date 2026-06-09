/**
 * Unit tests for pushBranchWithRebase, the helper that auto-rebases when the
 * remote branch has drifted (the AISDLC-68 rerun's "non-fast-forward" failure).
 *
 * Uses real temp git repos with two clones simulating origin + working clone.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pushBranchWithRebase } from './execute.js';
import { makeGitEnv } from './__test-helpers/git-env.js';

const execFileAsync = promisify(execFile);

// makeGitEnv() (AISDLC-257) constructs a minimal env that deliberately omits
// GIT_DIR + GIT_WORK_TREE so test git commands always bind to the temp repo's
// own .git, not a parent worktree's context. Identity is provided via
// GIT_AUTHOR_* / GIT_COMMITTER_* so we don't need `git config user.email` writes.

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: makeGitEnv() });
  return stdout.trim();
}

interface Setup {
  origin: string; // bare repo serving as origin
  workClone: string; // working clone the pipeline pushes from
  feature: string; // feature branch under test
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'push-rebase-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const workClone = join(root, 'work');
  const feature = 'feat/test';

  // Bare origin
  await execFileAsync('git', ['init', '-q', '--bare', origin], { env: makeGitEnv() });

  // Seed clone with main + feature branch
  await execFileAsync('git', ['clone', '-q', origin, seed], { env: makeGitEnv() });
  // Per-repo identity in .git/config so production code's `git rebase`
  // (which inherits process.env without GIT_AUTHOR_*) can find an identity.
  // Safe alongside env: makeGitEnv() — GIT_DIR is not polluted, so this
  // write lands in seed/.git/config (not the host worktree's config).
  await git(seed, 'config', 'user.email', 'test@test.invalid');
  await git(seed, 'config', 'user.name', 'Test');
  await writeFile(join(seed, 'README.md'), 'init\n');
  await git(seed, 'add', 'README.md');
  await git(seed, 'commit', '-q', '-m', 'init');
  try {
    await git(seed, 'branch', '-M', 'main');
  } catch {
    /* already main */
  }
  await git(seed, 'push', '-q', '-u', 'origin', 'main');
  await git(seed, 'checkout', '-q', '-b', feature);
  await writeFile(join(seed, 'feat.md'), 'feat\n');
  await git(seed, 'add', 'feat.md');
  await git(seed, 'commit', '-q', '-m', 'feat-init');
  await git(seed, 'push', '-q', '-u', 'origin', feature);

  // Work clone (simulates pipeline's worktree). Same per-repo identity as seed.
  await execFileAsync('git', ['clone', '-q', origin, workClone], { env: makeGitEnv() });
  await git(workClone, 'config', 'user.email', 'test@test.invalid');
  await git(workClone, 'config', 'user.name', 'Test');
  await git(workClone, 'fetch', 'origin', feature);
  await git(workClone, 'checkout', '-q', feature);

  // Have the seed clone advance origin's feature branch (simulates a drift
  // — another pipeline run, hand-edit, etc.).
  await writeFile(join(seed, 'drift.md'), 'drifted\n');
  await git(seed, 'add', 'drift.md');
  await git(seed, 'commit', '-q', '-m', 'drift');
  await git(seed, 'push', '-q', 'origin', feature);

  return { origin, workClone, feature };
}

async function setupNoDrift(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'push-rebase-nodrift-'));
  const origin = join(root, 'origin.git');
  const workClone = join(root, 'work');
  const feature = 'feat/test';

  await execFileAsync('git', ['init', '-q', '--bare', origin], { env: makeGitEnv() });
  await execFileAsync('git', ['clone', '-q', origin, workClone], { env: makeGitEnv() });
  // Per-repo identity for production-code rebase + commit (see setup() comment).
  await git(workClone, 'config', 'user.email', 'test@test.invalid');
  await git(workClone, 'config', 'user.name', 'Test');
  await writeFile(join(workClone, 'README.md'), 'init\n');
  await git(workClone, 'add', 'README.md');
  await git(workClone, 'commit', '-q', '-m', 'init');
  try {
    await git(workClone, 'branch', '-M', 'main');
  } catch {
    /* already */
  }
  await git(workClone, 'push', '-q', '-u', 'origin', 'main');
  await git(workClone, 'checkout', '-q', '-b', feature);
  await writeFile(join(workClone, 'feat.md'), 'feat\n');
  await git(workClone, 'add', 'feat.md');
  await git(workClone, 'commit', '-q', '-m', 'feat-init');

  return { origin, workClone, feature };
}

describe('pushBranchWithRebase', () => {
  let active: Setup | null = null;

  afterEach(async () => {
    if (active) {
      const root = active.origin.replace(/\/origin\.git$/, '');
      await rm(root, { recursive: true, force: true });
      active = null;
    }
  });

  it('does a plain push when remote is up-to-date (no drift)', async () => {
    active = await setupNoDrift();
    const log = { info: vi.fn() };
    const skipped = await pushBranchWithRebase(active.workClone, active.feature, log);
    expect(skipped).toBe(false);

    // Verify origin has our commit
    const seedSha = await git(active.workClone, 'rev-parse', 'HEAD');
    const remoteSha = await git(active.workClone, 'rev-parse', `origin/${active.feature}`);
    expect(remoteSha).toBe(seedSha);
    // No rebase needed → no recovery log line
    expect(log.info).not.toHaveBeenCalled();
  });

  it('rebases onto origin and retries push when remote has drifted', async () => {
    active = await setup();
    // Add a local commit on top of the (now stale) feature branch
    await writeFile(join(active.workClone, 'agent.md'), 'agent work\n');
    await git(active.workClone, 'add', 'agent.md');
    await git(active.workClone, 'commit', '-q', '-m', 'agent-commit');

    const log = { info: vi.fn() };
    const skipped = await pushBranchWithRebase(active.workClone, active.feature, log);
    expect(skipped).toBe(false);

    // Verify the agent's commit landed on top of the drift commit on origin.
    const remoteFiles = await git(
      active.workClone,
      'ls-tree',
      '-r',
      '--name-only',
      `origin/${active.feature}`,
    );
    expect(remoteFiles.split('\n')).toContain('agent.md');
    expect(remoteFiles.split('\n')).toContain('drift.md');

    // Recovery hint logged
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('non-fast-forward'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`origin/${active.feature}`));
  });

  it('throws a descriptive error when rebase fails (conflict)', async () => {
    active = await setup();

    // Create a CONFLICTING change to drift.md (which the drift commit also
    // modified — agent edits the same file with different content).
    await writeFile(join(active.workClone, 'drift.md'), 'agent edits this same file\n');
    await git(active.workClone, 'add', 'drift.md');
    await git(active.workClone, 'commit', '-q', '-m', 'agent-commit');

    const log = { info: vi.fn() };
    await expect(pushBranchWithRebase(active.workClone, active.feature, log)).rejects.toThrow(
      /Push rebase failed/,
    );

    // Worktree should not be left in a half-rebased state.
    const status = await git(active.workClone, 'status', '--porcelain');
    expect(status).not.toContain('UU');
  });

  it('skips push gracefully when no origin remote is configured (local-only mode, AISDLC-530)', async () => {
    // Repo has commits + a branch but NO 'origin' remote.
    // push would fail with "does not appear to be a git repository".
    // AISDLC-530: this is treated as local-only mode — skip gracefully, return true.
    const tmp = await mkdtemp(join(tmpdir(), 'push-local-'));
    const wc = join(tmp, 'work');
    const branch = 'feat/local-test';
    try {
      await execFileAsync('git', ['init', '-q', wc], { env: makeGitEnv() });
      await git(wc, 'config', 'user.email', 'test@test.invalid');
      await git(wc, 'config', 'user.name', 'Test');
      await writeFile(join(wc, 'a.md'), 'a\n');
      await git(wc, 'add', 'a.md');
      await git(wc, 'commit', '-q', '-m', 'init');
      // Rename to ensure a known branch name, then create the feature branch.
      try {
        await git(wc, 'branch', '-M', 'main');
      } catch {
        /* already main */
      }
      await git(wc, 'checkout', '-q', '-b', branch);
      await writeFile(join(wc, 'b.md'), 'b\n');
      await git(wc, 'add', 'b.md');
      await git(wc, 'commit', '-q', '-m', 'feat');
      // No remote configured — push must be skipped, not throw.
      const log = { info: vi.fn() };
      const skipped = await pushBranchWithRebase(wc, branch, log);
      expect(skipped).toBe(true);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("no 'origin' remote"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
