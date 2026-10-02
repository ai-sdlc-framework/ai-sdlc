import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  legacyNote,
  normalizeRemoteUrl,
  repoIdFor,
  resolveRepoFilter,
  selectByRepo,
} from './repo-id.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'repo-id-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}
function makeRepo(parent: string, name: string, opts: { origin?: string; commit?: boolean } = {}) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (opts.origin) git(dir, 'remote', 'add', 'origin', opts.origin);
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'f.txt'), `${parent}-${name}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', `init ${parent}`);
  }
  return dir;
}

describe('normalizeRemoteUrl', () => {
  it.each([
    ['https://GitHub.com/Org/Repo.git', 'github.com/Org/Repo'],
    ['git@GitHub.com:org/repo.git', 'github.com/org/repo'],
    ['ssh://git@host.example:2222/org/repo.git/', 'host.example:2222/org/repo'],
    ['https://user:s3cret@example.com/org/repo', 'example.com/org/repo'],
    ['https://tok@example.com/a.git', 'example.com/a'],
    ['', 'local'],
    [undefined, 'local'],
    ['https://@', 'local'],
  ])('%s -> %s', (raw, want) => {
    const got = normalizeRemoteUrl(raw);
    expect(got).toBe(want);
    expect(got).not.toContain('s3cret');
  });

  it('bounds the length and strips unsafe characters', () => {
    const got = normalizeRemoteUrl(`https://h.example/${'a'.repeat(500)}\n"; rm -rf`);
    expect(got.length).toBeLessThanOrEqual(200);
    expect(got).toMatch(/^[A-Za-z0-9._~:/-]+$/);
  });
});

describe('repoIdFor', () => {
  it('differs for same-named checkouts with different root commits', () => {
    const a = makeRepo(join(tmp, 'one'), 'proj', { origin: 'https://example.com/o/proj.git' });
    const b = makeRepo(join(tmp, 'two'), 'proj', { origin: 'https://example.com/o/proj.git' });
    const ia = repoIdFor(a);
    const ib = repoIdFor(b);
    expect(ia).toMatch(/^example\.com\/o\/proj#[0-9a-f]{40,64}$/);
    expect(ib).toMatch(/^example\.com\/o\/proj#[0-9a-f]{40,64}$/);
    expect(ia).not.toBe(ib);
  });

  it('is stable for one checkout and caches the result', () => {
    const a = makeRepo(tmp, 'proj', { origin: 'https://u:p@example.com/o/proj.git' });
    const id = repoIdFor(a);
    expect(id).not.toContain('u:p');
    expect(repoIdFor(a)).toBe(id);
  });

  it('uses "local" without an origin and undefined without commits', () => {
    expect(repoIdFor(makeRepo(tmp, 'noorigin'))).toMatch(/^local#[0-9a-f]{40,64}$/);
    expect(repoIdFor(makeRepo(tmp, 'empty', { commit: false }))).toBeUndefined();
    expect(repoIdFor(join(tmp, 'does-not-exist'))).toBeUndefined();
  });

  it('picks the smallest root commit when history has several', () => {
    const roots = ['b'.repeat(40), 'a'.repeat(40), 'zz-not-a-hash'];
    const run = (_cwd: string, args: string[]) =>
      args[0] === 'rev-list' ? roots.join('\n') : 'https://h.example/r.git';
    expect(repoIdFor('/virtual', run)).toBe(`h.example/r#${'a'.repeat(40)}`);
  });
});

describe('selectByRepo', () => {
  const me = { repoName: 'proj', repoId: 'h/r#' + 'a'.repeat(40) };
  const rows = [
    { repo: 'proj', repoId: me.repoId, n: 1 },
    { repo: 'proj', repoId: 'h/other#' + 'b'.repeat(40), n: 2 },
    { repo: 'proj', n: 3 },
    { repo: 'else', n: 4 },
  ];

  it('matches on repoId and falls back to the name only without one', () => {
    const sel = selectByRepo(rows, me);
    expect(sel.records.map((r) => r.n)).toEqual([1, 3]);
    expect(sel.legacy).toBe(1);
    expect(legacyNote(sel)).toContain('legacy fallback');
    expect(legacyNote({ legacy: 0 })).toBe('');
  });

  it('with no own repoId only legacy records match', () => {
    expect(selectByRepo(rows, { repoName: 'proj' }).records.map((r) => r.n)).toEqual([3]);
  });
});

describe('resolveRepoFilter', () => {
  const idA = 'h/r#' + 'a'.repeat(40);
  const idB = 'h/r#' + 'b'.repeat(40);
  const rows = [
    { repo: 'proj', repoId: idA, n: 1 },
    { repo: 'proj', repoId: idB, n: 2 },
    { repo: 'proj', n: 3 },
    { repo: 'solo', repoId: idA, n: 4 },
    { repo: 'old', n: 5 },
  ];

  it('accepts a repoId', () => {
    const r = resolveRepoFilter(rows, idA, { repoName: 'x' });
    expect(r.records.map((x) => x.n)).toEqual([1, 4]);
    expect(r.line).toContain(idA);
  });

  it('resolves the current checkout name to its repoId with a legacy label', () => {
    const r = resolveRepoFilter(rows, 'proj', { repoName: 'proj', repoId: idA });
    expect(r.records.map((x) => x.n)).toEqual([1, 3, 4]);
    expect(r.line).toContain(`repoId ${idA}`);
    expect(r.line).toContain('legacy fallback');
  });

  it('reports a single, ambiguous or missing repoId for another name', () => {
    expect(resolveRepoFilter(rows, 'solo', { repoName: 'x' }).line).toContain(`repoId ${idA}`);
    const amb = resolveRepoFilter(rows, 'proj', { repoName: 'x' });
    expect(amb.records).toHaveLength(3);
    expect(amb.line).toContain('2 repoIds');
    expect(amb.line).toContain(idB);
    expect(resolveRepoFilter(rows, 'old', { repoName: 'x' }).line).toContain('no repoId recorded');
  });
});
