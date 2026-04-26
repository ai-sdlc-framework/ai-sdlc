import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  slugifyBranch,
  worktreePath,
  verifyOwnership,
  assertOwnership,
  isExistingWorktree,
  WorktreeOwnershipError,
} from './worktree.js';

describe('slugifyBranch', () => {
  it('preserves alphanumeric, dot, dash, underscore', () => {
    expect(slugifyBranch('feat.add-foo_bar')).toBe('feat.add-foo_bar');
  });

  it('replaces forward slashes with dashes', () => {
    expect(slugifyBranch('feat/issue-42')).toBe('feat-issue-42');
  });

  it('collapses repeated dashes', () => {
    expect(slugifyBranch('feat//issue///42')).toBe('feat-issue-42');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyBranch('//foo//')).toBe('foo');
  });

  it('replaces non-slug-safe characters', () => {
    expect(slugifyBranch('feat@foo!bar?baz')).toBe('feat-foo-bar-baz');
  });

  it('throws on empty input', () => {
    expect(() => slugifyBranch('')).toThrow();
  });

  it('throws when nothing is slug-safe', () => {
    expect(() => slugifyBranch('@!?')).toThrow();
  });

  it('round-trips a typical issue branch', () => {
    expect(slugifyBranch('ai-sdlc/issue-247')).toBe('ai-sdlc-issue-247');
  });
});

describe('worktreePath', () => {
  it('joins the root dir with the slugified branch', () => {
    expect(worktreePath('/pool', 'feat/issue-42')).toBe('/pool/feat-issue-42');
  });
});

describe('verifyOwnership and assertOwnership', () => {
  let tmpRoot: string;
  let cloneDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'worktree-test-'));
    cloneDir = join(tmpRoot, 'clone');
    worktreeDir = join(tmpRoot, 'pool', 'my-branch');
    await mkdir(join(cloneDir, '.git', 'worktrees', 'my-branch'), { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns owned=true when the .git pointer lands inside the expected clone', async () => {
    const pointer = `gitdir: ${join(cloneDir, '.git', 'worktrees', 'my-branch')}`;
    await writeFile(join(worktreeDir, '.git'), pointer);
    const result = await verifyOwnership(worktreeDir, cloneDir);
    expect(result.owned).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.actualClone).toBe(resolve(cloneDir, '.git', 'worktrees', 'my-branch'));
  });

  it('accepts a relative pointer path', async () => {
    const relative = `../../clone/.git/worktrees/my-branch`;
    await writeFile(join(worktreeDir, '.git'), `gitdir: ${relative}`);
    const result = await verifyOwnership(worktreeDir, cloneDir);
    expect(result.owned).toBe(true);
  });

  it('returns owned=false with reason cross-clone when pointer goes elsewhere', async () => {
    const otherClone = join(tmpRoot, 'other-clone');
    await mkdir(join(otherClone, '.git', 'worktrees', 'my-branch'), { recursive: true });
    const pointer = `gitdir: ${join(otherClone, '.git', 'worktrees', 'my-branch')}`;
    await writeFile(join(worktreeDir, '.git'), pointer);
    const result = await verifyOwnership(worktreeDir, cloneDir);
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('cross-clone');
  });

  it('returns owned=false with reason pointer-missing when .git file does not exist', async () => {
    const result = await verifyOwnership(worktreeDir, cloneDir);
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('pointer-missing');
    expect(result.actualClone).toBeNull();
  });

  it('returns owned=false with reason pointer-malformed when .git is not a gitdir pointer', async () => {
    await writeFile(join(worktreeDir, '.git'), 'not a pointer');
    const result = await verifyOwnership(worktreeDir, cloneDir);
    expect(result.owned).toBe(false);
    expect(result.reason).toBe('pointer-malformed');
  });

  it('assertOwnership throws WorktreeOwnershipError on mismatch', async () => {
    const otherClone = join(tmpRoot, 'other-clone');
    await mkdir(join(otherClone, '.git', 'worktrees', 'my-branch'), { recursive: true });
    await writeFile(
      join(worktreeDir, '.git'),
      `gitdir: ${join(otherClone, '.git', 'worktrees', 'my-branch')}`,
    );
    await expect(assertOwnership(worktreeDir, cloneDir)).rejects.toThrow(WorktreeOwnershipError);
  });

  it('assertOwnership succeeds on owned worktree', async () => {
    await writeFile(
      join(worktreeDir, '.git'),
      `gitdir: ${join(cloneDir, '.git', 'worktrees', 'my-branch')}`,
    );
    await expect(assertOwnership(worktreeDir, cloneDir)).resolves.toBeUndefined();
  });
});

describe('isExistingWorktree', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'worktree-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns true when a .git pointer file exists', async () => {
    const wt = join(tmpRoot, 'wt');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), 'gitdir: /somewhere');
    expect(await isExistingWorktree(wt)).toBe(true);
  });

  it('returns false when no .git exists', async () => {
    expect(await isExistingWorktree(join(tmpRoot, 'nope'))).toBe(false);
  });

  it('returns false when .git is a directory (i.e., a regular clone, not a worktree)', async () => {
    const wt = join(tmpRoot, 'clone');
    await mkdir(join(wt, '.git'), { recursive: true });
    expect(await isExistingWorktree(wt)).toBe(false);
  });
});
