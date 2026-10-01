import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionResolver } from './attribution.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attribution-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function repo(path: string): string {
  mkdirSync(join(path, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

describe('AttributionResolver', () => {
  it('rejects relative, empty and NUL-bearing working directories', () => {
    const r = new AttributionResolver({ homeDir: root });
    expect(r.frameworkFor(undefined)).toBeNull();
    expect(r.frameworkFor('relative/dir')).toBeNull();
    expect(r.frameworkFor('/a\0b')).toBeNull();
  });

  it('requires both .ai-sdlc and .git, and names a deleted worktree after the parent repo', () => {
    const noGit = join(root, 'nogit');
    mkdirSync(join(noGit, '.ai-sdlc'), { recursive: true });
    const r = new AttributionResolver({ homeDir: join(root, 'home') });
    expect(r.frameworkFor(noGit)).toBeNull();
    const main = repo(join(root, 'main'));
    // worktree directory no longer exists on disk
    expect(r.frameworkFor(join(main, '.worktrees', 'gone-1', 'sub'))).toEqual({
      root: main,
      repo: 'main',
    });
  });

  it('names a live worktree after its owning repository and caches the answer', () => {
    const main = repo(join(root, 'main'));
    const wt = repo(join(main, '.worktrees', 'aisdlc-1'));
    const r = new AttributionResolver({ homeDir: join(root, 'home') });
    const ctx = r.frameworkFor(wt)!;
    expect(ctx).toEqual({ root: wt, repo: 'main' });
    expect(r.frameworkFor(wt)).toBe(ctx);
  });

  it('prefers the worktree segment, then a known branch id, then the sentinel', () => {
    const main = repo(join(root, 'main'));
    mkdirSync(join(main, 'backlog', 'completed'), { recursive: true });
    writeFileSync(join(main, 'backlog', 'completed', 'aisdlc-9 - done.md'), '');
    const r = new AttributionResolver({ homeDir: join(root, 'home') });
    const ctx = r.frameworkFor(main)!;
    expect(r.taskFor(ctx, join(main, '.worktrees', 'aisdlc-3', 'x'), 'aisdlc-9')).toBe('AISDLC-3');
    expect(r.taskFor(ctx, main, 'feat/aisdlc-9-x')).toBe('AISDLC-9');
    expect(r.taskFor(ctx, main, 'feat/aisdlc-10-x')).toBeUndefined();
    expect(r.taskFor(ctx, main, undefined)).toBeUndefined();
  });

  it('reads only a small plain sentinel and never follows a symlink', () => {
    const a = repo(join(root, 'a'));
    writeFileSync(join(a, '.active-task'), 'x'.repeat(1000));
    const b = repo(join(root, 'b'));
    writeFileSync(join(root, 'secret.txt'), 'AISDLC-5');
    symlinkSync(join(root, 'secret.txt'), join(b, '.active-task'));
    const c = repo(join(root, 'c'));
    writeFileSync(join(c, '.active-task'), 'free text, not an id');
    const r = new AttributionResolver({ homeDir: join(root, 'home') });
    for (const dir of [a, b, c]) {
      expect(r.taskFor(r.frameworkFor(dir)!, dir, undefined)).toBeUndefined();
    }
  });
});
