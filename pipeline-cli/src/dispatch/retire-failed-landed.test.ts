/** AISDLC-1243: the tick retires a failed verdict whose task landed. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { peekQueue } from './board.js';
import { execFileSync } from 'node:child_process';
import {
  completedTaskIdsOnMain,
  retireFailedLanded,
  retireFailedVerdict,
  retireLandedSweep,
} from './retire-landed.js';
import { landingDir, landingPath } from '../hierarchy/reconcile.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;
beforeEach(() => {
  board = path.join(mkdtempSync(path.join(tmpdir(), 'retire-failed-landed-')), 'dispatch');
  for (const d of ['failed', 'done', 'queue', 'inflight']) {
    mkdirSync(path.join(board, d), { recursive: true });
  }
});
afterEach(() => removeFixtureDir(path.dirname(board)));

const now = () => new Date('2026-11-08T12:00:00.000Z');
const seed = (id: string, manifest = false) => {
  writeFileSync(
    path.join(board, 'failed', `${id}.verdict.json`),
    JSON.stringify({ schemaVersion: 'v1', taskId: id, outcome: 'failed' }),
  );
  if (manifest) writeFileSync(path.join(board, 'failed', `${id}.manifest.json`), '{}');
};

describe('retireFailedLanded', () => {
  it('AC-1: moves a verdict and manifest whose task is in backlog/completed on main', () => {
    seed('AISDLC-1086', true);
    const out = retireFailedLanded(board, {
      completedOnMain: () => new Map([['AISDLC-1086', 'abc123']]),
      now,
    });
    expect(out).toEqual(['AISDLC-1086']);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-1086.verdict.json'))).toBe(false);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-1086.manifest.json'))).toBe(false);
    expect(existsSync(path.join(board, 'retired', 'AISDLC-1086.manifest.json'))).toBe(true);
    const rec = JSON.parse(
      readFileSync(path.join(board, 'retired', 'AISDLC-1086.verdict.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(rec['retiredReason']).toBe('task landed abc123');
    expect(rec['outcome']).toBe('failed');
    const log = readFileSync(path.join(board, 'board-events.jsonl'), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] as string)).toMatchObject({ taskId: 'AISDLC-1086' });
  });

  it('AC-2: leaves a verdict whose task is still open', () => {
    seed('AISDLC-2000');
    const out = retireFailedLanded(board, {
      completedOnMain: () => new Map([['AISDLC-1086', 'abc123']]),
      now,
    });
    expect(out).toEqual([]);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-2000.verdict.json'))).toBe(true);
    expect(existsSync(path.join(board, 'retired'))).toBe(false);
  });

  it('retires on a merged task PR when main cannot be read', () => {
    seed('AISDLC-1121');
    mkdirSync(landingDir(board), { recursive: true });
    writeFileSync(
      landingPath(board, 5),
      JSON.stringify({
        pr: 5,
        taskId: 'AISDLC-1121',
        kind: 'task',
        landed: '2026-11-07T00:00:00Z',
        landedSha: 'def456',
      }),
    );
    const out = retireFailedLanded(board, { completedOnMain: () => undefined, now });
    expect(out).toEqual(['AISDLC-1121']);
  });

  describe('filing PR never retires (AISDLC-1381)', () => {
    const filing = {
      pr: 2764,
      taskId: 'AISDLC-1308',
      landed: '2026-11-18T14:00:00Z',
      landedSha: '5700aa6b6',
    };
    it('refuses a retire when the task file is not in backlog/completed on main', () => {
      seed('AISDLC-1308');
      mkdirSync(landingDir(board), { recursive: true });
      writeFileSync(landingPath(board, 2764), JSON.stringify({ ...filing, kind: 'task' }));
      expect(retireFailedLanded(board, { completedOnMain: () => new Map(), now })).toEqual([]);
      expect(existsSync(path.join(board, 'failed', 'AISDLC-1308.verdict.json'))).toBe(true);
    });
    it('per-PR path: a filing-branch landing record does not retire', () => {
      seed('AISDLC-1308');
      expect(
        retireFailedVerdict(board, {
          taskId: 'AISDLC-1308',
          landedAt: filing.landed,
          prNumber: 2764,
          headBranch: 'ai-sdlc/file-aisdlc-1308',
        }),
      ).toBe(false);
    });
    it('sweep: a filing-branch landing record does not retire', () => {
      seed('AISDLC-1308');
      const r = retireLandedSweep(board, [
        { ...filing, headBranch: 'ai-sdlc/file-aisdlc-1308', kind: 'task' },
      ]);
      expect(r.moved).toEqual([]);
      expect(existsSync(path.join(board, 'failed', 'AISDLC-1308.verdict.json'))).toBe(true);
    });
  });

  describe('own code PR only (AISDLC-1297)', () => {
    const land = (rec: Record<string, unknown>) => {
      mkdirSync(landingDir(board), { recursive: true });
      writeFileSync(
        landingPath(board, rec['pr'] as number),
        JSON.stringify({ taskId: 'AISDLC-1285', landed: '2026-11-16T21:00:00Z', ...rec }),
      );
    };
    const seedPr = (prNumber?: number) =>
      writeFileSync(
        path.join(board, 'failed', 'AISDLC-1285.verdict.json'),
        JSON.stringify({
          schemaVersion: 'v1',
          taskId: 'AISDLC-1285',
          outcome: 'failed',
          ...(prNumber === undefined ? {} : { prNumber }),
        }),
      );
    const run = () => retireFailedLanded(board, { completedOnMain: () => new Map(), now });

    it('a landed record of another PR does not retire a verdict with a prNumber', () => {
      seedPr(2706);
      land({ pr: 2693, kind: 'task' });
      expect(run()).toEqual([]);
      expect(existsSync(path.join(board, 'failed', 'AISDLC-1285.verdict.json'))).toBe(true);
    });

    it('the verdict own PR retires it', () => {
      seedPr(2706);
      land({ pr: 2706, kind: 'task' });
      // main unreadable: the own-PR landing record is the only evidence (AISDLC-1381)
      expect(retireFailedLanded(board, { completedOnMain: () => undefined, now })).toEqual([
        'AISDLC-1285',
      ]);
    });

    it('completedOnMain retires with no landing record', () => {
      seedPr(2706);
      expect(
        retireFailedLanded(board, {
          completedOnMain: () => new Map([['AISDLC-1285', 'abc']]),
          now,
        }),
      ).toEqual(['AISDLC-1285']);
    });

    it('a filing-branch record does not retire a verdict without a prNumber', () => {
      seedPr();
      land({ pr: 2693, kind: 'task', headBranch: 'ai-sdlc/file-aisdlc-1285' });
      expect(run()).toEqual([]);
    });
  });

  it('AC-3: the 2026-11-08 board shows no failed entries after one tick', () => {
    const ids = ['AISDLC-1086', 'AISDLC-1121', 'AISDLC-1122', 'AISDLC-1147', 'AISDLC-1225'];
    for (const id of ids) seed(id);
    expect(peekQueue(board).failed).toBe(5);
    retireFailedLanded(board, {
      completedOnMain: () => new Map(ids.map((i) => [i, 'sha'])),
      now,
    });
    expect(peekQueue(board).failed).toBe(0);
  });

  it('ignores unreadable and non-task files', () => {
    writeFileSync(path.join(board, 'failed', 'AISDLC-9.verdict.json'), '{bad');
    writeFileSync(path.join(board, 'failed', 'junk.verdict.json'), '{}');
    expect(
      retireFailedLanded(board, {
        completedOnMain: () =>
          new Map([
            ['AISDLC-9', 'x'],
            ['junk', 'x'],
          ]),
        now,
      }),
    ).toEqual([]);
  });
});

describe('completedTaskIdsOnMain', () => {
  it('lists completed task ids at origin/main, undefined without that ref', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'completed-main-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' });
      git('init', '-q');
      expect(completedTaskIdsOnMain(repo)).toBeUndefined();
      mkdirSync(path.join(repo, 'backlog', 'completed'), { recursive: true });
      writeFileSync(path.join(repo, 'backlog', 'completed', 'AISDLC-77 - a title.md'), 'x');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--no-verify');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const ids = completedTaskIdsOnMain(repo);
      expect([...(ids?.keys() ?? [])]).toEqual(['AISDLC-77']);
    } finally {
      removeFixtureDir(repo);
    }
  });
});
