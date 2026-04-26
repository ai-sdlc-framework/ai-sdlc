import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreePoolManager, WorktreePoolError } from './worktree-pool.js';
import { WorktreeOwnershipError } from './worktree.js';

interface GitCall {
  args: string[];
  cwd?: string;
}

interface FakeGitOptions {
  /** Map of (joined args) → stdout. Default returns empty stdout. */
  stdouts?: Record<string, string>;
  /** Args (joined by space) that should throw. */
  throwOn?: Set<string>;
  /** Side effect on each call (e.g., create the worktree directory). */
  onCall?: (call: GitCall) => Promise<void> | void;
}

function makeFakeGit(opts: FakeGitOptions = {}) {
  const calls: GitCall[] = [];
  const git = async (args: string[], gitOpts?: { cwd?: string }) => {
    const call: GitCall = { args, cwd: gitOpts?.cwd };
    calls.push(call);
    const key = args.join(' ');
    if (opts.throwOn?.has(key)) {
      throw new Error(`fake git refused: ${key}`);
    }
    if (opts.onCall) await opts.onCall(call);
    return { stdout: opts.stdouts?.[key] ?? '', stderr: '' };
  };
  return { git, calls };
}

describe('WorktreePoolManager', () => {
  let tmpRoot: string;
  let cloneDir: string;
  let poolDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pool-test-'));
    cloneDir = join(tmpRoot, 'clone');
    poolDir = join(tmpRoot, 'pool');
    await mkdir(join(cloneDir, '.git', 'worktrees'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('allocate', () => {
    it('creates a fresh worktree when none exists', async () => {
      const { git, calls } = makeFakeGit({
        onCall: async (call) => {
          if (call.args[0] === 'worktree' && call.args[1] === 'add') {
            const path = call.args[2];
            await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-issue-42'), { recursive: true });
            await mkdir(path, { recursive: true });
            await writeFile(
              join(path, '.git'),
              `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-issue-42')}`,
            );
          }
        },
      });
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      const handle = await pool.allocate('feat/issue-42');
      expect(handle.created).toBe(true);
      expect(handle.slug).toBe('feat-issue-42');
      expect(handle.path).toBe(join(poolDir, 'feat-issue-42'));
      expect(calls).toHaveLength(1);
      expect(calls[0].args.slice(0, 4)).toEqual([
        'worktree',
        'add',
        join(poolDir, 'feat-issue-42'),
        '-b',
      ]);
    });

    it('uses provided baseBranch', async () => {
      const { git, calls } = makeFakeGit({
        onCall: async (call) => {
          if (call.args[0] === 'worktree' && call.args[1] === 'add') {
            const path = call.args[2];
            await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
            await mkdir(path, { recursive: true });
            await writeFile(
              join(path, '.git'),
              `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`,
            );
          }
        },
      });
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await pool.allocate('feat/x', { baseBranch: 'origin/dev' });
      expect(calls[0].args[5]).toBe('origin/dev');
    });

    it('adopts an existing worktree (created=false) when ownership matches', async () => {
      // Pre-create a worktree owned by cloneDir.
      await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`);

      const { git, calls } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      const handle = await pool.allocate('feat/x');
      expect(handle.created).toBe(false);
      expect(calls).toHaveLength(0); // adoption does not call git
    });

    it('throws WorktreeOwnershipError when adopting a worktree from a different clone (strict guard)', async () => {
      const otherClone = join(tmpRoot, 'other-clone');
      await mkdir(join(otherClone, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(
        join(wt, '.git'),
        `gitdir: ${join(otherClone, '.git', 'worktrees', 'feat-x')}`,
      );

      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await expect(pool.allocate('feat/x')).rejects.toThrow(WorktreeOwnershipError);
    });

    it('warns instead of throwing on cross-clone with advisory guard', async () => {
      const otherClone = join(tmpRoot, 'other-clone');
      await mkdir(join(otherClone, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(
        join(wt, '.git'),
        `gitdir: ${join(otherClone, '.git', 'worktrees', 'feat-x')}`,
      );

      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(
        cloneDir,
        { rootDir: poolDir, ownershipGuard: 'advisory' },
        { git },
      );
      const warn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
      try {
        const handle = await pool.allocate('feat/x');
        expect(handle.created).toBe(false);
        expect(warnings.some((w) => w.includes('advisory ownership mismatch'))).toBe(true);
      } finally {
        console.warn = warn;
      }
    });

    it('wraps git failures in WorktreePoolError', async () => {
      const { git } = makeFakeGit({ throwOn: new Set(['worktree add']) });
      // Above won't match because args include the path; build a custom git:
      const fail = async () => {
        throw new Error('git went boom');
      };
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git: fail });
      await expect(pool.allocate('feat/y')).rejects.toThrow(WorktreePoolError);
      // unused
      void git;
    });
  });

  describe('reclaim', () => {
    it('refuses to remove a worktree with uncommitted changes (default safety)', async () => {
      // Set up an existing worktree.
      await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`);

      const { git } = makeFakeGit({ stdouts: { 'status --porcelain': ' M file.ts' } });
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await expect(pool.reclaim('feat/x')).rejects.toThrow(/uncommitted changes/);
    });

    it('removes a clean worktree via git worktree remove', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`);

      const { git, calls } = makeFakeGit({ stdouts: { 'status --porcelain': '' } });
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await pool.reclaim('feat/x');
      const removeCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
      expect(removeCall).toBeDefined();
      expect(removeCall!.args).not.toContain('--force');
    });

    it('passes --force when explicitly requested even with uncommitted changes', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`);

      const { git, calls } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await pool.reclaim('feat/x', { force: true });
      const removeCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
      expect(removeCall!.args).toContain('--force');
      // status check is skipped when force is set
      const statusCall = calls.find((c) => c.args.join(' ') === 'status --porcelain');
      expect(statusCall).toBeUndefined();
    });

    it('is idempotent on a missing worktree', async () => {
      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await expect(pool.reclaim('feat/never-existed')).resolves.toBeUndefined();
    });

    it('cleanupOnMerge defers to reclaim with safety check', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'feat-x'), { recursive: true });
      const wt = join(poolDir, 'feat-x');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'feat-x')}`);
      const { git } = makeFakeGit({ stdouts: { 'status --porcelain': ' M leftover' } });
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await expect(pool.cleanupOnMerge('feat/x')).rejects.toThrow(/uncommitted changes/);
    });
  });

  describe('list and reclaimStale', () => {
    it('list returns slugs of existing worktrees and skips non-worktree directories', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'wt-a'), { recursive: true });
      await mkdir(join(cloneDir, '.git', 'worktrees', 'wt-b'), { recursive: true });
      const a = join(poolDir, 'wt-a');
      const b = join(poolDir, 'wt-b');
      const c = join(poolDir, 'not-a-worktree');
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await mkdir(c, { recursive: true });
      await writeFile(join(a, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'wt-a')}`);
      await writeFile(join(b, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'wt-b')}`);

      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      const slugs = await pool.list();
      expect(slugs.sort()).toEqual(['wt-a', 'wt-b']);
    });

    it('list returns [] when pool root does not yet exist', async () => {
      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: join(tmpRoot, 'never') }, { git });
      expect(await pool.list()).toEqual([]);
    });

    it('reclaimStale identifies worktrees older than the threshold (dry run)', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'fresh'), { recursive: true });
      await mkdir(join(cloneDir, '.git', 'worktrees', 'stale'), { recursive: true });
      const fresh = join(poolDir, 'fresh');
      const stale = join(poolDir, 'stale');
      await mkdir(fresh, { recursive: true });
      await mkdir(stale, { recursive: true });
      await writeFile(
        join(fresh, '.git'),
        `gitdir: ${join(cloneDir, '.git', 'worktrees', 'fresh')}`,
      );
      await writeFile(
        join(stale, '.git'),
        `gitdir: ${join(cloneDir, '.git', 'worktrees', 'stale')}`,
      );

      // Backdate the stale worktree by 30 days.
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(stale, longAgo, longAgo);

      const { git, calls } = makeFakeGit();
      const pool = new WorktreePoolManager(
        cloneDir,
        { rootDir: poolDir, staleThresholdDays: 14 },
        { git },
      );
      const result = await pool.reclaimStale();
      expect(result).toEqual(['stale']);
      // Dry run — should NOT have called git remove.
      expect(calls.find((c) => c.args[1] === 'remove')).toBeUndefined();
    });

    it('reclaimStale with apply: true calls git worktree remove --force', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'old'), { recursive: true });
      const old = join(poolDir, 'old');
      await mkdir(old, { recursive: true });
      await writeFile(join(old, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'old')}`);
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(old, longAgo, longAgo);

      const { git, calls } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await pool.reclaimStale({ apply: true });
      const removeCall = calls.find((c) => c.args[1] === 'remove');
      expect(removeCall).toBeDefined();
      expect(removeCall!.args).toContain('--force');
    });

    it('reclaimStale honors injected clock', async () => {
      await mkdir(join(cloneDir, '.git', 'worktrees', 'wt'), { recursive: true });
      const wt = join(poolDir, 'wt');
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(cloneDir, '.git', 'worktrees', 'wt')}`);

      const { git } = makeFakeGit();
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const pool = new WorktreePoolManager(
        cloneDir,
        { rootDir: poolDir, staleThresholdDays: 14 },
        { git, now: () => future },
      );
      const result = await pool.reclaimStale();
      expect(result).toEqual(['wt']);
    });
  });

  describe('adopt', () => {
    it('throws WorktreePoolError if no worktree exists at the slug path', async () => {
      const { git } = makeFakeGit();
      const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir }, { git });
      await expect(pool.adopt('feat/never')).rejects.toThrow(WorktreePoolError);
    });
  });
});
