/** AISDLC-1158: landing retires the failed verdict of its task. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listBoard, peekQueue } from './board.js';
import { retireBlockedManifest, retireFailedVerdict, retireLandedSweep } from './retire-landed.js';
import { collectHandoffState } from '../hierarchy/handoff.js';
import { briefStatus } from '../hierarchy/brief-status.js';
import { renderBriefBlock } from '../hierarchy/brief-format.js';
import { listLanding, reconcile, type ReconcilePr } from '../hierarchy/reconcile.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let repo: string;
let board: string;
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'retire-landed-'));
  board = path.join(repo, '.ai-sdlc', 'dispatch');
  for (const d of ['failed', 'done', 'queue', 'inflight', 'briefs'])
    mkdirSync(path.join(board, d), { recursive: true });
});
afterEach(() => removeFixtureDir(repo));

const verdict = {
  schemaVersion: 'v1',
  taskId: 'AISDLC-1153',
  outcome: 'failed',
  completedAt: '2026-11-02T15:36:38.855Z',
  workerId: 'w',
  workerKind: 'in-session-agent',
  prNumber: 2282,
  notes: 'push refused',
  cause: 'push-non-fast-forward',
};
function seedFailed(): void {
  writeFileSync(path.join(board, 'failed', 'AISDLC-1153.verdict.json'), JSON.stringify(verdict));
  writeFileSync(
    path.join(board, 'failed', 'AISDLC-1153.manifest.json'),
    '{"taskId":"AISDLC-1153"}',
  );
}
const merged: ReconcilePr = {
  prNumber: 2282,
  taskId: 'AISDLC-1153',
  title: 'fix: x (AISDLC-1153)',
  headSha: 'head1',
  mergeSha: 'b48d5a2e',
  merged: true,
};
const read = (sub: string, f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(board, sub, f), 'utf-8')) as Record<string, unknown>;

describe('mark-landed retires a failed verdict', () => {
  it('moves the verdict and manifest to done/ with the landing fields (AC-1)', () => {
    seedFailed();
    reconcile([merged], {
      boardDir: board,
      execute: () => ({ ran: true }),
      now: () => new Date('2026-11-02T16:02:00.000Z'),
    });
    expect(existsSync(path.join(board, 'failed', 'AISDLC-1153.verdict.json'))).toBe(false);
    expect(existsSync(path.join(board, 'failed', 'AISDLC-1153.manifest.json'))).toBe(false);
    expect(existsSync(path.join(board, 'done', 'AISDLC-1153.manifest.json'))).toBe(true);
    const done = read('done', 'AISDLC-1153.verdict.json');
    expect(done).toMatchObject({
      outcome: 'success',
      landedSha: 'b48d5a2e',
      landedAt: '2026-11-02T16:02:00.000Z',
      supersededCause: 'push-non-fast-forward',
      supersededVerdict: verdict,
    });
  });

  it('counts the task as done in status, brief-status and the handoff (AC-2)', () => {
    seedFailed();
    writeFileSync(
      path.join(board, 'briefs', 'a.md'),
      `# a\n\n${renderBriefBlock([{ task: 'AISDLC-1153', after: [], wave: 1 }])}\n`,
    );
    expect(peekQueue(board)).toMatchObject({ done: 0, failed: 1 });
    expect(briefStatus(board)[0]?.done).toBe(0);
    reconcile([merged], { boardDir: board, execute: () => ({ ran: true }) });
    expect(peekQueue(board)).toMatchObject({ done: 1, failed: 0 });
    expect(listBoard(board).find((e) => e.taskId === 'AISDLC-1153')?.state).toBe('done');
    expect(briefStatus(board)[0]?.done).toBe(1);
    const state = collectHandoffState(board);
    expect(state.board.filter((e) => e.state === 'failed')).toEqual([]);
    expect(state.board.find((e) => e.taskId === 'AISDLC-1153')?.state).toBe('done');
  });
});

describe('retire-landed', () => {
  it('does nothing without a failed verdict, with a done verdict, or for a bad id', () => {
    const input = { taskId: 'AISDLC-1153', landedAt: 't' };
    expect(retireFailedVerdict(board, input)).toBe(false);
    seedFailed();
    writeFileSync(path.join(board, 'done', 'AISDLC-1153.verdict.json'), '{}');
    expect(retireFailedVerdict(board, input)).toBe(false);
    expect(retireFailedVerdict(board, { ...input, taskId: '../x' })).toBe(false);
  });

  it('ignores an unreadable or already-successful failed verdict', () => {
    writeFileSync(path.join(board, 'failed', 'AISDLC-1153.verdict.json'), 'not json');
    expect(retireFailedVerdict(board, { taskId: 'AISDLC-1153', landedAt: 't' })).toBe(false);
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-1153.verdict.json'),
      JSON.stringify({ outcome: 'success' }),
    );
    expect(retireFailedVerdict(board, { taskId: 'AISDLC-1153', landedAt: 't' })).toBe(false);
  });

  it('keeps an existing done manifest and falls back to the outcome as cause', () => {
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-7.verdict.json'),
      JSON.stringify({ taskId: 'AISDLC-7', outcome: 'blocked' }),
    );
    writeFileSync(path.join(board, 'failed', 'AISDLC-7.manifest.json'), 'old');
    writeFileSync(path.join(board, 'done', 'AISDLC-7.manifest.json'), 'kept');
    expect(retireFailedVerdict(board, { taskId: 'AISDLC-7', landedAt: 't', prNumber: 5 })).toBe(
      true,
    );
    expect(readFileSync(path.join(board, 'done', 'AISDLC-7.manifest.json'), 'utf-8')).toBe('kept');
    expect(existsSync(path.join(board, 'failed', 'AISDLC-7.manifest.json'))).toBe(false);
    expect(read('done', 'AISDLC-7.verdict.json')).toMatchObject({
      supersededCause: 'blocked',
      prNumber: 5,
    });
  });

  it('sweeps landed records once, and reports what it moved (AC-3)', () => {
    seedFailed();
    const records = [
      { pr: 2282, taskId: 'AISDLC-1153', landed: 't', headSha: 'h' },
      { pr: 3, landed: 't' },
      { pr: 4, taskId: 'AISDLC-9' },
    ];
    expect(retireLandedSweep(board, records)).toEqual({
      moved: [{ taskId: 'AISDLC-1153', pr: 2282 }],
    });
    expect(read('done', 'AISDLC-1153.verdict.json')).toMatchObject({ landedSha: 'h' });
    expect(retireLandedSweep(board, records)).toEqual({ moved: [] });
    expect(listLanding(board)).toEqual([]);
  });
});

describe('cli-dispatch retire-landed', () => {
  it('moves stale entries for landed records and is idempotent', async () => {
    const { runDispatchCli } = await import('../cli/dispatch.js');
    const { writeFileSync: w } = await import('node:fs');
    seedFailed();
    mkdirSync(path.join(board, 'landing'), { recursive: true });
    w(
      path.join(board, 'landing', '2282.json'),
      JSON.stringify({
        pr: 2282,
        kind: 'task',
        taskId: 'AISDLC-1153',
        owner: 'machine',
        state: 'merged',
        action: 'mark-landed',
        landed: '2026-11-02T16:02:00.000Z',
        landedSha: 'b48d5a2e',
        history: [],
      }),
    );
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out += String(c);
      return true;
    });
    expect(await runDispatchCli(['retire-landed', '--board-dir', board])).toBe(0);
    expect(JSON.parse(out).moved).toEqual([{ taskId: 'AISDLC-1153', pr: 2282 }]);
    out = '';
    expect(await runDispatchCli(['retire-landed', '--board-dir', board])).toBe(0);
    expect(JSON.parse(out).moved).toEqual([]);
    spy.mockRestore();
  });
});

describe('only the task code PR retires a failed verdict (AISDLC-1177)', () => {
  const seed = (id: string, extra: Record<string, unknown>): void => {
    writeFileSync(
      path.join(board, 'failed', `${id}.verdict.json`),
      JSON.stringify({ taskId: id, outcome: 'failed', cause: 'x', ...extra }),
    );
  };
  const stillFailed = (id: string): boolean =>
    existsSync(path.join(board, 'failed', `${id}.verdict.json`)) &&
    !existsSync(path.join(board, 'done', `${id}.verdict.json`));
  const run = (pr: ReconcilePr): void => {
    reconcile([pr], { boardDir: board, execute: () => ({ ran: true }), now: () => new Date() });
  };

  it('keeps the 1156 shape failed: verdict PR 2308, filing PR 2288 merged (AC-1)', () => {
    seed('AISDLC-1156', { prNumber: 2308 });
    run({
      prNumber: 2288,
      taskId: 'AISDLC-1156',
      title: 'chore(docs): file backlog task AISDLC-1156 (AISDLC-1156)',
      headBranch: 'ai-sdlc/file-aisdlc-1156',
      headSha: 'h',
      mergeSha: 'm',
      merged: true,
    });
    expect(stillFailed('AISDLC-1156')).toBe(true);
    expect(
      retireLandedSweep(board, [{ pr: 2288, taskId: 'AISDLC-1156', landed: 't' }]).moved,
    ).toEqual([]);
    expect(stillFailed('AISDLC-1156')).toBe(true);
  });

  it('keeps the 1167 shape failed: no verdict prNumber, filing PR 2317 merged (AC-2, AC-4)', () => {
    seed('AISDLC-1167', {});
    run({
      prNumber: 2317,
      taskId: 'AISDLC-1167',
      title: 'chore(docs): file backlog task AISDLC-1167 (AISDLC-1167)',
      headBranch: 'ai-sdlc/file-aisdlc-1167',
      headSha: 'h',
      mergeSha: 'm',
      merged: true,
    });
    expect(stillFailed('AISDLC-1167')).toBe(true);
    const records = listLanding(board);
    expect(records[0]).toMatchObject({ kind: 'docs', headBranch: 'ai-sdlc/file-aisdlc-1167' });
    expect(retireLandedSweep(board, records).moved).toEqual([]);
    expect(stillFailed('AISDLC-1167')).toBe(true);
  });

  it('refuses a docs head branch or non-task kind when given directly (AC-2)', () => {
    seed('AISDLC-1167', {});
    const base = { taskId: 'AISDLC-1167', landedAt: 't' };
    expect(retireFailedVerdict(board, { ...base, headBranch: 'docs/x' })).toBe(false);
    expect(retireFailedVerdict(board, { ...base, kind: 'docs' })).toBe(false);
  });

  it('still retires on a matching prNumber or a task-kind PR with none (AC-3)', () => {
    seed('AISDLC-1', { prNumber: 5 });
    seed('AISDLC-2', {});
    expect(retireFailedVerdict(board, { taskId: 'AISDLC-1', landedAt: 't', prNumber: 5 })).toBe(
      true,
    );
    expect(
      retireFailedVerdict(board, {
        taskId: 'AISDLC-2',
        landedAt: 't',
        prNumber: 9,
        kind: 'task',
        headBranch: 'ai-sdlc/aisdlc-2-x',
      }),
    ).toBe(true);
  });
});

describe('landing retires a blocked manifest (AISDLC-1204)', () => {
  function seedBlocked(): void {
    mkdirSync(path.join(board, 'blocked'), { recursive: true });
    writeFileSync(
      path.join(board, 'blocked', 'AISDLC-1153.manifest.json'),
      '{"taskId":"AISDLC-1153","block":{"reason":"awaiting gate re-run"}}',
    );
  }

  it('reconcile moves it to done/ with the merge sha', () => {
    seedBlocked();
    reconcile([merged], { boardDir: board, execute: () => ({ ran: true }) });
    expect(existsSync(path.join(board, 'blocked', 'AISDLC-1153.manifest.json'))).toBe(false);
    expect(existsSync(path.join(board, 'done', 'AISDLC-1153.manifest.json'))).toBe(true);
    const v = read('done', 'AISDLC-1153.verdict.json');
    expect(v['outcome']).toBe('success');
    expect(v['landedSha']).toBe('b48d5a2e');
    expect(v['prNumber']).toBe(2282);
  });

  it('the sweep retires it, and a repeat or a docs PR does nothing', () => {
    seedBlocked();
    const rec = {
      pr: 2282,
      taskId: 'AISDLC-1153',
      landed: '2026-11-06T00:00:00Z',
      landedSha: 'abc',
    };
    expect(
      retireBlockedManifest(board, { taskId: 'AISDLC-1153', landedAt: 'x', kind: 'docs' }),
    ).toBe(false);
    expect(retireLandedSweep(board, [rec]).moved).toEqual([{ taskId: 'AISDLC-1153', pr: 2282 }]);
    expect(retireLandedSweep(board, [rec]).moved).toEqual([]);
    expect(retireBlockedManifest(board, { taskId: 'bad id', landedAt: 'x' })).toBe(false);
  });
});
