/**
 * Unit tests for the HEAD save+restore helpers in execute.ts.
 *
 * These shipped to fix the AISDLC-68 incident where the pipeline switched the
 * user's worktree to the issue branch and never restored it.
 *
 * Uses real temp git repos rather than mocking — execute.ts has a deep
 * dependency tree that's expensive to mock, and the helpers run only `git`
 * subprocess calls so a 50ms temp-repo setup is faster than mocking it all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureCurrentBranch, restoreOriginalBranch } from './execute.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'execute-headrestore-'));
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@test.com');
  await git(dir, 'config', 'user.name', 'test');
  await writeFile(join(dir, 'README.md'), '# initial\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-q', '-m', 'initial');
  // Rename default branch to 'main' for predictability across systems.
  try {
    await git(dir, 'branch', '-M', 'main');
  } catch {
    // already main
  }
  return dir;
}

describe('captureCurrentBranch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns the symbolic branch name when HEAD is on a branch', async () => {
    expect(await captureCurrentBranch(repo)).toBe('main');
  });

  it('falls back to commit SHA when HEAD is detached', async () => {
    const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    await git(repo, 'checkout', '--detach', sha.trim());

    const result = await captureCurrentBranch(repo);
    expect(result).toBe(sha.trim());
  });

  it('returns null when workDir is not a git repo', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'not-a-repo-'));
    try {
      const result = await captureCurrentBranch(tmp);
      expect(result).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('restoreOriginalBranch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
    // Add a feature branch we can switch to in tests.
    await git(repo, 'checkout', '-q', '-b', 'feat/work');
    await writeFile(join(repo, 'feat.md'), 'feat\n');
    await git(repo, 'add', 'feat.md');
    await git(repo, 'commit', '-q', '-m', 'feat');
    await git(repo, 'checkout', '-q', 'main');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function makeLog() {
    return { info: vi.fn() };
  }

  it('does nothing when originalHead is null', async () => {
    const log = makeLog();
    await restoreOriginalBranch(repo, null, log);
    expect(await captureCurrentBranch(repo)).toBe('main');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('does nothing when current HEAD already matches original', async () => {
    const log = makeLog();
    await restoreOriginalBranch(repo, 'main', log);
    expect(await captureCurrentBranch(repo)).toBe('main');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('checks out original HEAD when worktree is clean and HEAD differs', async () => {
    await git(repo, 'checkout', '-q', 'feat/work');
    expect(await captureCurrentBranch(repo)).toBe('feat/work');

    const log = makeLog();
    await restoreOriginalBranch(repo, 'main', log);

    expect(await captureCurrentBranch(repo)).toBe('main');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('refuses to checkout when worktree has uncommitted changes — logs recovery hint', async () => {
    await git(repo, 'checkout', '-q', 'feat/work');
    // Dirty the worktree.
    await writeFile(join(repo, 'README.md'), '# modified\n');

    const log = makeLog();
    await restoreOriginalBranch(repo, 'main', log);

    // HEAD did NOT change.
    expect(await captureCurrentBranch(repo)).toBe('feat/work');
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('worktree dirty'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('git stash'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('git checkout main'));
  });

  it('logs a warning when checkout itself fails (target ref does not exist)', async () => {
    await git(repo, 'checkout', '-q', 'feat/work');

    const log = makeLog();
    await restoreOriginalBranch(repo, 'no-such-branch', log);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('failed to restore HEAD'));
  });

  it('handles missing log gracefully', async () => {
    await git(repo, 'checkout', '-q', 'feat/work');
    await writeFile(join(repo, 'README.md'), 'modified\n');

    await expect(restoreOriginalBranch(repo, 'main', undefined)).resolves.toBeUndefined();
  });
});
