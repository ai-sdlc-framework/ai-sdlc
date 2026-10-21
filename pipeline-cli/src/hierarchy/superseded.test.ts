import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { carriedIds, closeSupersededPr, isCliBranchShape, taskIsDone } from './superseded.js';
import type { CommandRunner } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'superseded-'));
  mkdirSync(path.join(dir, 'backlog', 'completed'), { recursive: true });
  writeFileSync(path.join(dir, 'backlog', 'completed', 'aisdlc-7 - Thing.md'), '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

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
  it('closes when all three conditions hold, with a comment and an audit record', () => {
    const { result, closeCalls, calls } = go({});
    expect(result).toMatchObject({ closed: true, supersededBy: 99 });
    expect(closeCalls).toHaveLength(1);
    const comment = calls.find((c) => c[2] === 'comment')!;
    expect(comment.join(' ')).toContain('#99');
    const audit = JSON.parse(
      readFileSync(path.join(dir, 'audit', 'superseded-close.jsonl'), 'utf-8').trim(),
    );
    expect(audit).toMatchObject({ type: 'superseded-close', pr: 5, supersededBy: 99 });
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

  it('does not close when no landed PR carries the same id', () => {
    const { result, closeCalls } = go({ merged: [{ number: 99, title: 'chore: DEC-0267' }] });
    expect(result).toMatchObject({ closed: false, reason: 'no landed PR carries the same id' });
    expect(closeCalls).toHaveLength(0);
  });

  it('does not count the PR itself as the landed one', () => {
    const { result } = go({ merged: [{ number: 5, title: 'chore: DEC-0266' }] });
    expect(result.closed).toBe(false);
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

  it('does not close when the PR names no id or GitHub cannot be read', () => {
    expect(go({ title: 'chore: sync', files: ['a.md'] }).result.closed).toBe(false);
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
    expect(carriedIds('a DEC-0266', 'ai-sdlc/file-x', ['p/AISDLC-9.md'])).toEqual(
      expect.arrayContaining(['DEC-0266', 'AISDLC-9']),
    );
  });
});
