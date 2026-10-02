import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitEnv,
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
    ['https://gitlab.com/my_org/r.git', 'gitlab.com/my_org/r'],
    ['https://h.example/a?token=SECRETQ', 'h.example/a'],
    ['https://h.example/a#SECRETF', 'h.example/a'],
    ['https://u:pa/ss@h.example/a', 'local'],
    ['file:///Users/bob/code/proj', 'local'],
    ['/Users/bob/code/proj', 'local'],
    ['../sibling', 'local'],
    ['~/code/proj', 'local'],
    ['C:\\Users\\bob\\proj', 'local'],
  ])('%s -> %s', (raw, want) => {
    const got = normalizeRemoteUrl(raw);
    expect(got).toBe(want);
    expect(got).not.toContain('s3cret');
    expect(got).not.toContain('SECRET');
    expect(got).not.toContain('bob');
  });

  it('keeps distinct URLs distinct instead of stripping characters', () => {
    expect(normalizeRemoteUrl('https://gitlab.com/my_org/r')).not.toBe(
      normalizeRemoteUrl('https://gitlab.com/myorg/r'),
    );
    expect(normalizeRemoteUrl('https://h.example/a+b')).toBe('h.example/a%2Bb');
    expect(normalizeRemoteUrl('https://h.example/a%b')).toBe('h.example/a%25b');
    expect(normalizeRemoteUrl('https://h.example/a+b')).not.toBe(
      normalizeRemoteUrl('https://h.example/ab'),
    );
  });

  it('hashes the full value when it must truncate so long URLs stay distinct', () => {
    const a = normalizeRemoteUrl(`https://h.example/${'a'.repeat(300)}1`);
    const b = normalizeRemoteUrl(`https://h.example/${'a'.repeat(300)}2`);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(a).not.toBe(b);
  });

  it('bounds the length and strips unsafe characters', () => {
    const got = normalizeRemoteUrl(`https://h.example/${'a'.repeat(500)}\n"; rm -rf`);
    expect(got.length).toBeLessThanOrEqual(200);
    expect(got).toMatch(/^[A-Za-z0-9._~:/%-]+$/);
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

  it('does not cache a failed lookup: a later commit yields an id', () => {
    const dir = makeRepo(tmp, 'late', { commit: false });
    expect(repoIdFor(dir)).toBeUndefined();
    writeFileSync(join(dir, 'f.txt'), 'x');
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'init');
    expect(repoIdFor(dir)).toMatch(/^local#[0-9a-f]{40,64}$/);
  });

  it('yields undefined for a .git that points at a missing gitdir', () => {
    const dir = join(tmp, 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent\n');
    expect(repoIdFor(dir)).toBeUndefined();
  });

  it('maps a file:// or local-path origin to local', () => {
    const a = makeRepo(tmp, 'filer', { origin: 'file:///Users/bob/secret/proj' });
    expect(repoIdFor(a)).toMatch(/^local#/);
  });

  it('is not redirected by an exported GIT_DIR', () => {
    const a = makeRepo(join(tmp, 'one'), 'proj');
    const b = makeRepo(join(tmp, 'two'), 'proj');
    const ia = repoIdFor(a);
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = join(a, '.git');
    process.env.GIT_WORK_TREE = a;
    try {
      const ib = repoIdFor(b);
      expect(ib).toBeDefined();
      expect(ib).not.toBe(ia);
      expect(repoIdFor(join(tmp, 'one', 'proj'))).toBe(ia);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('picks the smallest root commit when history has several', () => {
    const roots = ['b'.repeat(40), 'a'.repeat(40), 'zz-not-a-hash'];
    const run = (_cwd: string, args: string[]) =>
      args[0] === 'rev-list' ? roots.join('\n') : 'https://h.example/r.git';
    expect(repoIdFor('/virtual', run)).toBe(`h.example/r#${'a'.repeat(40)}`);
  });
});

describe('gitEnv', () => {
  it('removes discovery and config overrides', () => {
    const out = gitEnv({
      GIT_DIR: 'x',
      GIT_WORK_TREE: 'x',
      GIT_COMMON_DIR: 'x',
      GIT_INDEX_FILE: 'x',
      GIT_CONFIG_PARAMETERS: 'x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'evil',
      GIT_CEILING_DIRECTORIES: '/',
      PATH: '/bin',
    });
    expect(Object.keys(out).sort()).toEqual(['GIT_TERMINAL_PROMPT', 'PATH']);
  });
});

describe('selectByRepo', () => {
  const me = { repoName: 'proj', repoId: 'h/r#' + 'a'.repeat(40) };
  const rows = [
    { repo: 'proj', repoId: me.repoId, n: 1 },
    { repo: 'proj', repoId: 'h/other#' + 'b'.repeat(40), n: 2 },
    { repo: 'proj', n: 3 },
    { repo: 'else', n: 4 },
    { repo: 'proj', repoIdUnavailable: true, n: 5 },
  ];

  it('matches on repoId and falls back to the name only without either field', () => {
    const sel = selectByRepo(rows, me);
    expect(sel.records.map((r) => r.n)).toEqual([1, 3]);
    expect(sel.legacy).toBe(1);
    expect(sel.unavailable).toBe(1);
    expect(legacyNote(sel)).toContain('repoId unavailable');
    expect(legacyNote(sel)).toContain('legacy fallback');
    expect(legacyNote({ legacy: 0, unavailable: 0 })).toBe('');
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
    { repo: 'proj', repoIdUnavailable: true, n: 6 },
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
    expect(amb.line).toContain('repoId unavailable');
    expect(amb.line).toContain('2 repoIds');
    expect(amb.line).toContain(idB);
    expect(resolveRepoFilter(rows, 'old', { repoName: 'x' }).line).toContain('no repoId recorded');
  });
});
