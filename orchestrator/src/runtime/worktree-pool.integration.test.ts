/**
 * Integration test: 3 issues against a real git repo, verify isolated worktrees +
 * distinct ports + clean reclamation. Per RFC-0010 §17 Phase 2 acceptance criterion.
 *
 * Uses a real `git` binary so the .git pointer file format and worktree mechanics are
 * exercised end-to-end. Skipped automatically if git is unavailable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreePoolManager } from './worktree-pool.js';
import { allocatePort, deterministicPort } from './port-allocator.js';

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
    await execFileAsync('git', ['init', '-b', 'main', cloneDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: cloneDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: cloneDir });
    await writeFile(join(cloneDir, 'README.md'), '# fixture\n');
    await execFileAsync('git', ['add', '.'], { cwd: cloneDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: cloneDir });
  });

  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it('dispatches 3 isolated worktrees with distinct ports and reclaims cleanly', async () => {
    if (!hasGit) {
      console.warn('skipping worktree-pool integration test: git not available');
      return;
    }
    const pool = new WorktreePoolManager(cloneDir, { rootDir: poolDir });

    // Allocate 3 worktrees off main.
    const branches = ['feat/issue-101', 'feat/issue-102', 'feat/issue-103'];
    const handles = await Promise.all(
      branches.map((b) => pool.allocate(b, { baseBranch: 'main' })),
    );

    // Each handle reports created=true and a unique slug + path.
    expect(handles.every((h) => h.created)).toBe(true);
    expect(new Set(handles.map((h) => h.slug)).size).toBe(3);
    expect(new Set(handles.map((h) => h.path)).size).toBe(3);

    // Each worktree is a real one (.git is a file pointer, not a directory).
    for (const h of handles) {
      const dotGitPath = join(h.path, '.git');
      const { stdout } = await execFileAsync('cat', [dotGitPath]);
      expect(stdout).toMatch(/^gitdir:\s/);
    }

    // Ports are deterministic per worktree path AND distinct across the three.
    const ports = await Promise.all(
      handles.map((h) => allocatePort(h.path, { isPortFree: async () => true })),
    );
    expect(new Set(ports).size).toBe(3);
    for (const [i, h] of handles.entries()) {
      expect(ports[i]).toBe(deterministicPort(h.path));
    }

    // Pool list returns all three slugs.
    const slugs = await pool.list();
    expect(slugs.sort()).toEqual(handles.map((h) => h.slug).sort());

    // Reclamation: all three have no uncommitted changes (just got created).
    for (const branch of branches) {
      await pool.reclaim(branch);
    }
    expect(await pool.list()).toEqual([]);
  });

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
