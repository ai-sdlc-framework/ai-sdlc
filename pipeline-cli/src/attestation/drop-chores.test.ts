import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIn } from '../cli/attestation.js';
import {
  dropAttestationChores,
  isAttestationChorePath,
  isAttestationChoreSubject,
} from './drop-chores.js';

let dir: string;
const g = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (file: string, content: string, msg: string): void => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
  g('add', '--', file);
  g('commit', '-q', '-m', msg);
};
const envelopes = (): string[] => readdirSync(join(dir, '.ai-sdlc/attestations'));

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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('identification rule', () => {
  it('matches the two chore subjects only', () => {
    expect(isAttestationChoreSubject('chore: sign attestation for abc')).toBe(true);
    expect(
      isAttestationChoreSubject('chore: commit pending transcript leaves and review ledger (X)'),
    ).toBe(true);
    expect(isAttestationChoreSubject('feat: real work')).toBe(false);
  });
  it('allows attestation and leaf paths only', () => {
    expect(isAttestationChorePath('.ai-sdlc/attestations/a.dsse.json')).toBe(true);
    expect(isAttestationChorePath('.ai-sdlc/transcript-leaves.jsonl')).toBe(true);
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

  it('drops a stale sign + leaves stack, restores the leaves, and a re-sign leaves one envelope on HEAD', async () => {
    commit('src/a.ts', 'a', 'feat: work');
    const stale = g('rev-parse', 'HEAD');
    commit(
      '.ai-sdlc/transcript-leaves.jsonl',
      '{"leaf":1}\n',
      'chore: commit pending transcript leaves (AISDLC-1)',
    );
    commit('src/b.ts', 'b', 'feat: more work');
    commit(
      `.ai-sdlc/attestations/${stale}.v6.dsse.json`,
      '{}',
      `chore: sign attestation for ${stale}`,
    );

    const r = await dropAttestationChores(gitIn(dir), { target: 'main', taskId: 'AISDLC-1' });
    expect(r.kind).toBe('dropped');
    expect(g('log', '--format=%s', 'origin/main..HEAD').split('\n')).toEqual([
      'feat: more work',
      'feat: work',
    ]);
    expect(g('status', '--porcelain')).toContain('transcript-leaves.jsonl');

    g('commit', '-q', '-m', 'chore: commit pending transcript leaves (AISDLC-1)');
    const head = g('rev-parse', 'HEAD');
    commit(
      `.ai-sdlc/attestations/${head}.v6.dsse.json`,
      JSON.stringify({ subject: head }),
      `chore: sign attestation for ${head}`,
    );
    expect(envelopes()).toEqual([`${head}.v6.dsse.json`]);
    expect(g('rev-parse', 'HEAD~1')).toBe(head);
  });

  it('refuses and changes nothing when a candidate touches another path', async () => {
    commit('src/a.ts', 'a', 'chore: sign attestation for fake');
    const before = g('rev-parse', 'HEAD');
    const r = await dropAttestationChores(gitIn(dir), { target: 'main' });
    expect(r).toMatchObject({ kind: 'refused', paths: ['src/a.ts'] });
    expect(g('rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses to rewrite a dirty worktree', async () => {
    commit('.ai-sdlc/attestations/a.dsse.json', '{}', 'chore: sign attestation for x');
    writeFileSync(join(dir, 'README.md'), 'dirty');
    const r = await dropAttestationChores(gitIn(dir), { target: 'main' });
    expect(r.kind).toBe('failed');
  });
});
