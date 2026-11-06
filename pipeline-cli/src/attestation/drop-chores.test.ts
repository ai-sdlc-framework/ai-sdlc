import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIn } from '../cli/attestation.js';
import {
  dropAttestationChores,
  isAttestationChorePath,
  isAttestationChoreSubject,
} from './drop-chores.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
const g = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (file: string, content: string, msg: string): void => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
  g('add', '--', file);
  g('commit', '-q', '-m', msg);
};
const LEDGER = '.ai-sdlc/reviews/aisdlc-1.jsonl';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drop-chores-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  commit('README.md', 'x', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'ai-sdlc/aisdlc-1-x');
});
afterEach(() => removeFixtureDir(dir));

describe('identification rule', () => {
  it('matches the two chore subjects only', () => {
    expect(isAttestationChoreSubject('chore: sign attestation for abc')).toBe(true);
    expect(
      isAttestationChoreSubject('chore: commit pending transcript leaves and review ledger (X)'),
    ).toBe(true);
    expect(isAttestationChoreSubject('feat: real work')).toBe(false);
  });
  it('allows the task review ledger only (no proof trees remain, RFC-0061)', () => {
    expect(isAttestationChorePath('.ai-sdlc/attestations/a.dsse.json')).toBe(false);
    expect(isAttestationChorePath('.ai-sdlc/transcript-leaves.jsonl')).toBe(false);
    expect(isAttestationChorePath('.ai-sdlc/reviews/aisdlc-1.jsonl', 'AISDLC-1')).toBe(true);
    expect(isAttestationChorePath('.ai-sdlc/reviews/aisdlc-1.jsonl', 'aisdlc-1')).toBe(true);
    expect(isAttestationChorePath('.ai-sdlc/reviews/AISDLC-1.jsonl', 'AISDLC-1')).toBe(false);
    expect(isAttestationChorePath('.ai-sdlc/reviews/aisdlc-1.jsonl')).toBe(false);
    expect(isAttestationChorePath('src/a.ts')).toBe(false);
  });
});

describe('dropAttestationChores', () => {
  it('does nothing on a clean stack', async () => {
    commit('src/a.ts', 'a', 'feat: work');
    expect(await dropAttestationChores(gitIn(dir), { target: 'main' })).toEqual({ kind: 'none' });
  });

  it('drops a stale chore stack and restores the ledger to the index', async () => {
    commit('src/a.ts', 'a', 'feat: work');
    commit(LEDGER, '{"v":1}\n', 'chore: commit pending transcript leaves (AISDLC-1)');
    commit('src/b.ts', 'b', 'feat: more work');

    const r = await dropAttestationChores(gitIn(dir), { target: 'main', taskId: 'AISDLC-1' });
    expect(r.kind).toBe('dropped');
    expect(g('log', '--format=%s', 'origin/main..HEAD').split('\n')).toEqual([
      'feat: more work',
      'feat: work',
    ]);
    expect(g('status', '--porcelain')).toContain('aisdlc-1.jsonl');
  });

  it('refuses and changes nothing when a candidate touches another path', async () => {
    commit('src/a.ts', 'a', 'chore: sign attestation for fake');
    const before = g('rev-parse', 'HEAD');
    const r = await dropAttestationChores(gitIn(dir), { target: 'main' });
    expect(r).toMatchObject({ kind: 'refused', paths: ['src/a.ts'] });
    expect(g('rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses to rewrite a dirty worktree', async () => {
    commit(LEDGER, '{}', 'chore: commit pending transcript leaves (AISDLC-1)');
    writeFileSync(join(dir, 'README.md'), 'dirty');
    const r = await dropAttestationChores(gitIn(dir), { target: 'main', taskId: 'AISDLC-1' });
    expect(r.kind).toBe('failed');
  });
});
