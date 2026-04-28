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

const execFileAsync = promisify(execFile);

// Strip GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE so test git commands run
// inside tmpDir bind to tmpDir's own .git rather than a parent worktree's
// (husky pre-push exports these). See AISDLC-72.
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: cleanGitEnv() });
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
  await execFileAsync('git', ['init', '-q', '--bare', origin], { env: cleanGitEnv() });

  // Seed clone with main + feature branch
  await execFileAsync('git', ['clone', '-q', origin, seed], { env: cleanGitEnv() });
  await git(seed, 'config', 'user.email', 't@t.com');
  await git(seed, 'config', 'user.name', 't');
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

  // Work clone (simulates pipeline's worktree)
  await execFileAsync('git', ['clone', '-q', origin, workClone], { env: cleanGitEnv() });
  await git(workClone, 'config', 'user.email', 't@t.com');
  await git(workClone, 'config', 'user.name', 't');
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

  await execFileAsync('git', ['init', '-q', '--bare', origin], { env: cleanGitEnv() });
  await execFileAsync('git', ['clone', '-q', origin, workClone], { env: cleanGitEnv() });
  await git(workClone, 'config', 'user.email', 't@t.com');
  await git(workClone, 'config', 'user.name', 't');
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
    await pushBranchWithRebase(active.workClone, active.feature, log);

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
    await pushBranchWithRebase(active.workClone, active.feature, log);

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

  it('rethrows non-rebase errors as-is (e.g. auth failure)', async () => {
    // Origin doesn't exist → push fails with a different error pattern.
    const tmp = await mkdtemp(join(tmpdir(), 'push-bad-'));
    const wc = join(tmp, 'work');
    try {
      await execFileAsync('git', ['init', '-q', wc], { env: cleanGitEnv() });
      await git(wc, 'config', 'user.email', 't@t.com');
      await git(wc, 'config', 'user.name', 't');
      await writeFile(join(wc, 'a.md'), 'a\n');
      await git(wc, 'add', 'a.md');
      await git(wc, 'commit', '-q', '-m', 'init');
      // No remote 'origin' configured at all → push fails with "does not appear to be a git repository"
      await expect(pushBranchWithRebase(wc, 'main', undefined)).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
