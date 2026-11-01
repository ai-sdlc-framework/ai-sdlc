import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeSupersededPr, isCliBranchShape, taskIsDone } from './superseded.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'superseded-'));
  mkdirSync(path.join(dir, 'backlog', 'completed'), { recursive: true });
  writeFileSync(path.join(dir, 'backlog', 'completed', 'aisdlc-7 - Thing.md'), '');
});
afterEach(() => removeFixtureDir(dir));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

interface Scenario {
  branch?: string;
  title?: string;
  state?: string;
  cross?: boolean;
  files?: string[];
  merged?: { number: number; title: string; headRefName?: string }[];
  headSha?: Record<string, string | null>;
  mainSha?: Record<string, string | null>;
  commentFails?: boolean;
  /** path -> `git log` line (sha, subject); undefined path = default PR #99; null = no output. */
  landed?: Record<string, { sha: string; subject: string } | null>;
  byShaList?: { number: number; mergeCommit: { oid: string } }[];
}

function runnerFor(s: Scenario) {
  const calls: string[][] = [];
  const files = s.files ?? ['.ai-sdlc/_decisions/events/x__DEC-0266__a.json'];
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args]);
    const a = args.join(' ');
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (a.startsWith('pr view')) {
      return ok(
        JSON.stringify({
          state: s.state ?? 'OPEN',
          headRefName: s.branch ?? 'ai-sdlc/decisions-sync',
          headRefOid: 'h'.repeat(40),
          title: s.title ?? 'chore(decisions): sync DEC-0266',
          isCrossRepository: s.cross ?? false,
          files: files.map((p) => ({ path: p })),
        }),
      );
    }
    if (file === 'git') {
      const p = args[args.length - 1]!;
      const e = s.landed && p in s.landed ? s.landed[p] : { sha: SHA_C, subject: 'chore: x (#99)' };
      return e ? ok(`${e.sha}\t${e.subject}\n`) : ok('');
    }
    if (a.startsWith('pr list') && a.includes('mergeCommit')) {
      return ok(JSON.stringify(s.byShaList ?? []));
    }
    if (a.startsWith('pr list')) {
      return ok(JSON.stringify(s.merged ?? [{ number: 99, title: 'chore: record DEC-0266' }]));
    }
    if (a.startsWith('api')) {
      const m = /contents\/([^?]+)(\?ref=(.*))?$/.exec(args[1]!);
      const p = decodeURI(m![1]!);
      const table = m![3] ? (s.headSha ?? {}) : (s.mainSha ?? {});
      const v = p in table ? table[p] : SHA_A;
      return v === null
        ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : ok(`${v}\n`);
    }
    if (a.startsWith('pr comment')) {
      return s.commentFails ? { status: 1, stdout: '', stderr: 'x' } : ok('');
    }
    return ok('');
  };
  return { run, calls };
}

const go = (s: Scenario) => {
  const r = runnerFor(s);
  const result = closeSupersededPr(r.run, {
    cwd: dir,
    boardDir: dir,
    pr: 5,
    now: () => new Date('2026-10-21T00:00:00.000Z'),
  });
  const closeCalls = r.calls.filter((c) => c[1] === 'pr' && c[2] === 'close');
  return { result, closeCalls, calls: r.calls };
};

describe('closeSupersededPr (AISDLC-1011, DEC-0266)', () => {
  it('closes when all conditions hold, with a comment and an audit record', () => {
    const { result, closeCalls, calls } = go({});
    expect(result).toMatchObject({ closed: true, supersededBy: 99 });
    expect(closeCalls).toHaveLength(1);
    const comment = calls.find((c) => c[2] === 'comment')!;
    expect(comment.join(' ')).toContain('#99');
    expect(comment.join(' ')).toContain(SHA_C);
    const audit = JSON.parse(
      readFileSync(path.join(dir, 'audit', 'superseded-close.jsonl'), 'utf-8').trim(),
    );
    expect(audit).toMatchObject({
      type: 'superseded-close',
      pr: 5,
      supersededBy: 99,
      mergeCommit: SHA_C,
    });
    expect(Object.values(audit.contentHashes)).toEqual([SHA_A]);
  });

  it('closes a Done task branch and treats a path deleted on both sides as identical', () => {
    const f = 'docs/x.md';
    const { result } = go({
      branch: 'ai-sdlc/aisdlc-7-thing',
      title: 'feat: thing (AISDLC-7)',
      files: [f],
      merged: [{ number: 40, title: 'feat: thing (AISDLC-7)' }],
      headSha: { [f]: null },
      mainSha: { [f]: null },
      landed: { [f]: { sha: SHA_D, subject: 'feat: thing (#40)' } },
    });
    expect(result).toMatchObject({ closed: true, supersededBy: 40 });
  });

  it('does not close when the branch was not opened by the CLI', () => {
    const { result, closeCalls } = go({ branch: 'feat/hand-made' });
    expect(result).toMatchObject({ closed: false });
    expect(closeCalls).toHaveLength(0);
  });

  it('does not close a task branch whose task is not Done', () => {
    const { result, closeCalls } = go({
      branch: 'ai-sdlc/aisdlc-8-other',
      title: 'feat: other (AISDLC-8)',
      merged: [{ number: 41, title: 'feat: other (AISDLC-8)' }],
    });
    expect(result).toMatchObject({ closed: false });
    expect(closeCalls).toHaveLength(0);
  });

  it('does not close a task branch when no landed PR carries its id', () => {
    const { result, closeCalls } = go({
      branch: 'ai-sdlc/aisdlc-7-thing',
      title: 'feat: thing (AISDLC-7)',
      merged: [{ number: 99, title: 'chore: AISDLC-70' }],
    });
    expect(result).toMatchObject({ closed: false, reason: 'no landed PR carries the same id' });
    expect(closeCalls).toHaveLength(0);
  });

  it('does not count the PR itself as the landed one', () => {
    const { result } = go({
      branch: 'ai-sdlc/aisdlc-7-thing',
      title: 'feat: thing (AISDLC-7)',
      merged: [{ number: 5, title: 'chore: AISDLC-7' }],
    });
    expect(result.closed).toBe(false);
  });

  it('names the PR that landed the content, not a title match on a shared id', () => {
    const f = 'docs/x.md';
    const { result, calls } = go({
      branch: 'ai-sdlc/aisdlc-7-thing',
      title: 'feat: thing (AISDLC-7)',
      files: [f],
      merged: [{ number: 1298, title: 'docs: RFC-0053 (AISDLC-7)' }],
      landed: { [f]: { sha: SHA_D, subject: 'feat: thing (#1950)' } },
    });
    expect(result).toMatchObject({ closed: true, supersededBy: 1950, mergeCommit: SHA_D });
    const comment = calls.find((c) => c[2] === 'comment')!.join(' ');
    expect(comment).toContain('#1950');
    expect(comment).not.toContain('#1298');
  });

  it('refuses when paths landed through different PRs', () => {
    const { result, closeCalls } = go({
      files: ['a.md', 'b.md'],
      landed: {
        'a.md': { sha: SHA_C, subject: 'x (#10)' },
        'b.md': { sha: SHA_D, subject: 'y (#11)' },
      },
    });
    expect(result.closed).toBe(false);
    expect((result as { reason: string }).reason).toContain('#10');
    expect((result as { reason: string }).reason).toContain('#11');
    expect(closeCalls).toHaveLength(0);
  });

  it('refuses when a path cannot be attributed, and falls back to a sha search', () => {
    expect(
      go({ landed: { '.ai-sdlc/_decisions/events/x__DEC-0266__a.json': null } }).result.closed,
    ).toBe(false);
    const f = 'a.md';
    const noSubject = { sha: SHA_D, subject: 'squash without number' };
    expect(go({ files: [f], landed: { [f]: noSubject } }).result.closed).toBe(false);
    expect(
      go({
        files: [f],
        landed: { [f]: noSubject },
        byShaList: [{ number: 77, mergeCommit: { oid: SHA_D } }],
      }).result,
    ).toMatchObject({
      closed: true,
      supersededBy: 77,
    });
    expect(
      go({ files: [f], landed: { [f]: { sha: SHA_D, subject: 'z (#5)' } } }).result.closed,
    ).toBe(false);
  });

  it('does not close when one path differs on main', () => {
    const f = '.ai-sdlc/_decisions/events/x__DEC-0266__a.json';
    const { result, closeCalls } = go({ headSha: { [f]: SHA_B } });
    expect(result).toMatchObject({ closed: false });
    expect(closeCalls).toHaveLength(0);
  });

  it('does not close when a path is deleted on one side only', () => {
    const f = '.ai-sdlc/_decisions/events/x__DEC-0266__a.json';
    expect(go({ mainSha: { [f]: null } }).result.closed).toBe(false);
  });

  it('does not close a closed, fork, empty or possibly truncated PR', () => {
    expect(go({ state: 'CLOSED' }).result.closed).toBe(false);
    expect(go({ cross: true }).result.closed).toBe(false);
    expect(go({ files: [] }).result.closed).toBe(false);
    const many = Array.from({ length: 100 }, (_, i) => `f${i}.md`);
    expect(go({ files: many, title: 'DEC-0266' }).result.closed).toBe(false);
  });

  it('does not close when the comment cannot be posted', () => {
    const { result, closeCalls } = go({ commentFails: true });
    expect(result.closed).toBe(false);
    expect(closeCalls).toHaveLength(0);
  });

  it('does not close when GitHub cannot be read', () => {
    const bad = closeSupersededPr(() => ({ status: 1, stdout: '', stderr: 'down' }), {
      cwd: dir,
      boardDir: dir,
      pr: 5,
      now: () => new Date(),
    });
    expect(bad.closed).toBe(false);
  });
});

describe('helpers', () => {
  it('recognises CLI branch shapes', () => {
    expect(isCliBranchShape('ai-sdlc/file-x')).toBe(true);
    expect(isCliBranchShape('ai-sdlc/decisions-sync')).toBe(true);
    expect(isCliBranchShape('ai-sdlc/aisdlc-7-x')).toBe(true);
    expect(isCliBranchShape('feat/x')).toBe(false);
  });
  it('finds Done tasks and carried ids', () => {
    expect(taskIsDone(dir, 'AISDLC-7')).toBe(true);
    expect(taskIsDone(dir, 'AISDLC-70')).toBe(false);
    expect(taskIsDone(path.join(dir, 'nope'), 'AISDLC-7')).toBe(false);
  });
});
