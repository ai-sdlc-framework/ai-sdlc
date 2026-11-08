/** Land and repair before new tasks (AISDLC-1189, DEC-0373). */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueTasks } from '../dispatch/enqueue.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { runDispatchTick, type LoopDeps } from './dispatch-loop.js';
import {
  acquireReconcileLock,
  countedTaskPrs,
  formatOpenPrs,
  openPrState,
  openTaskPrs,
  RECONCILE_LOCK_STALE_MS,
  releaseReconcileLock,
  resolveOpenPrLimit,
  withReconcileLock,
} from './open-pr-limit.js';

let tmp: string;
let board: string;
let clock: number;
let spawns: string[];
let order: string[];

function queue(taskId: string, wave = 1): void {
  enqueueTasks(board, [{ taskId, wave }], {
    baseSha: 'abc1234',
    dispatchedBy: 'operator-dispatch',
    resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()}.md`,
  });
}

/** Turn a queued manifest into a repair: a resume block and no wave, as resumeDone leaves it. */
function makeRepair(taskId: string): void {
  const f = path.join(board, 'queue', `${taskId}.dispatch.json`);
  const m = JSON.parse(readFileSync(f, 'utf-8')) as Record<string, unknown>;
  delete m.wave;
  m.resume = { resumedAt: new Date(clock).toISOString(), resumedBy: 'test', note: 'fix' };
  writeFileSync(f, JSON.stringify(m));
}

function landing(pr: number, over: Record<string, unknown> = {}): void {
  mkdirSync(path.join(board, 'landing'), { recursive: true });
  writeFileSync(
    path.join(board, 'landing', `${pr}.json`),
    JSON.stringify({
      pr,
      kind: 'task',
      owner: 'x',
      state: 'open',
      action: 'none',
      history: [],
      ...over,
    }),
  );
}

function deps(over: Partial<LoopDeps> = {}, limit?: number): LoopDeps {
  return {
    boardDir: board,
    workerId: 'operator-dispatch',
    now: () => new Date(clock),
    enqueue: () => [],
    clear: async (o) => ({ executor: o.executor, ok: true, settleMs: 0 }),
    playbook: (v) => ({ taskId: v.taskId, action: 'requeue', result: 'done', reason: 'ok' }),
    operational: new Set(['clear-executor-context', 'requeue', 'land-eligible-prs']),
    ephemeral: {
      down: async () => ({ ok: true }),
      spawn: async (id) => {
        order.push(`spawn:${id}`);
        spawns.push(id);
      },
      cap: () => 5,
      openPrs: () =>
        openPrState(board, limit === undefined ? {} : { AI_SDLC_OPEN_PR_LIMIT: String(limit) }),
    },
    ...over,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'open-pr-limit-'));
  board = path.join(tmp, 'dispatch');
  mkdirSync(board, { recursive: true });
  clock = Date.parse('2026-11-05T12:00:00.000Z');
  spawns = [];
  order = [];
});
afterEach(() => removeFixtureDir(tmp));

describe('tick order', () => {
  it('lands, then reconciles, before any spawn (AC-1)', async () => {
    queue('AISDLC-1');
    await runDispatchTick(
      deps({
        landEligible: async () => {
          order.push('land');
          return { landed: [], refused: [] };
        },
        reconcileNow: () => {
          order.push('reconcile');
        },
      }),
    );
    expect(order).toEqual(['land', 'reconcile', 'spawn:AISDLC-1']);
  });

  it('spawns a repair queued by the in-tick reconcile ahead of a brief task (AC-2)', async () => {
    queue('AISDLC-1');
    await runDispatchTick(
      deps({
        reconcileNow: () => {
          queue('AISDLC-2');
          makeRepair('AISDLC-2');
        },
      }),
    );
    expect(spawns).toEqual(['AISDLC-2', 'AISDLC-1']);
  });

  it('a failing landing or reconcile pass does not stop the spawn', async () => {
    queue('AISDLC-1');
    await runDispatchTick(
      deps({
        landEligible: async () => {
          throw new Error('boom');
        },
        reconcileNow: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(spawns).toEqual(['AISDLC-1']);
  });
});

describe('open-PR limit at spawn', () => {
  it('holds a new task at the limit and names the open PRs; still claims a repair (AC-3)', async () => {
    landing(11);
    landing(12);
    queue('AISDLC-1');
    queue('AISDLC-2');
    makeRepair('AISDLC-2');
    const r = await runDispatchTick(deps({}, 2));
    expect(spawns).toEqual(['AISDLC-2']);
    expect(r.ephemeral?.heldForOpenPrs?.taskIds).toEqual(['AISDLC-1']);
    expect(r.ephemeral?.heldForOpenPrs?.reason).toContain('#11, #12');
  });

  it('claims a new task below the limit', async () => {
    landing(11);
    queue('AISDLC-1');
    await runDispatchTick(deps({}, 2));
    expect(spawns).toEqual(['AISDLC-1']);
  });
});

describe('limit resolution and counting', () => {
  it('resolves env, then config, then executors.max; invalid falls back (AC-4)', () => {
    expect(resolveOpenPrLimit(board, {})).toBe(3);
    writeFileSync(path.join(board, 'config.json'), JSON.stringify({ executors: { max: 5 } }));
    expect(resolveOpenPrLimit(board, {})).toBe(5);
    writeFileSync(
      path.join(board, 'config.json'),
      JSON.stringify({ executors: { max: 5, openPrLimit: 2 } }),
    );
    expect(resolveOpenPrLimit(board, {})).toBe(2);
    expect(resolveOpenPrLimit(board, { AI_SDLC_OPEN_PR_LIMIT: '4' })).toBe(4);
    expect(resolveOpenPrLimit(board, { AI_SDLC_OPEN_PR_LIMIT: 'abc' })).toBe(2);
    expect(resolveOpenPrLimit(board, { AI_SDLC_OPEN_PR_LIMIT: '0' })).toBe(2);
    expect(resolveOpenPrLimit(board, { AI_SDLC_OPEN_PR_LIMIT: '1.5' })).toBe(2);
    writeFileSync(
      path.join(board, 'config.json'),
      JSON.stringify({ executors: { max: 5, openPrLimit: -1 } }),
    );
    expect(resolveOpenPrLimit(board, {})).toBe(5);
    writeFileSync(path.join(board, 'config.json'), '{nope');
    expect(resolveOpenPrLimit(board, {})).toBe(3);
  });

  it('does not count landed, closed-unlanded or non-task records (AC-5)', () => {
    landing(1);
    landing(2, { landed: 'x' });
    landing(3, { closedUnlanded: 'x' });
    landing(4, { kind: 'docs' });
    landing(5, { kind: 'decisions-sync' });
    landing(6, { kind: 'deps' });
    landing(7);
    expect(openTaskPrs(board)).toEqual([1, 7]);
    const s = openPrState(board, { AI_SDLC_OPEN_PR_LIMIT: '2' });
    expect(s.atLimit).toBe(true);
    expect(formatOpenPrs(s)).toContain('OPEN PRS 2 counted of limit 2, 2 total of ceiling');
    expect(formatOpenPrs({ ...s, atLimit: false, open: [1], counted: [1], excluded: [] })).toBe(
      `OPEN PRS 1 counted of limit 2, 1 total of ceiling ${s.ceiling}`,
    );
  });
});

function inflight(taskId: string): void {
  mkdirSync(path.join(board, 'inflight'), { recursive: true });
  writeFileSync(
    path.join(board, 'inflight', `${taskId}.dispatch.json`),
    JSON.stringify({ taskId }),
  );
}

describe('re-entering PRs and the ceiling (AISDLC-1234, DEC-0396)', () => {
  it('excludes inflight and queued-repair tasks; plain queued and landed behave as before', () => {
    landing(1, { taskId: 'AISDLC-1' });
    inflight('AISDLC-1');
    landing(2, { taskId: 'AISDLC-2' });
    queue('AISDLC-2');
    makeRepair('AISDLC-2');
    landing(3, { taskId: 'AISDLC-3' });
    queue('AISDLC-3');
    landing(4, { taskId: 'AISDLC-4', landed: 'x' });
    inflight('AISDLC-4');
    landing(5);
    expect(countedTaskPrs(board)).toEqual({ counted: [3, 5], excluded: [1, 2] });
    const s = openPrState(board, {});
    expect(s.excluded).toEqual([1, 2]);
    expect(formatOpenPrs(s)).toContain('excluded (re-entering): #1, #2');
  });

  function reenter(n: number): void {
    for (let i = 0; i < n; i++) {
      landing(100 + i, { taskId: `AISDLC-${100 + i}` });
      inflight(`AISDLC-${100 + i}`);
    }
  }

  it('the ceiling holds at limit + max total open PRs even with counted below limit', async () => {
    reenter(4);
    landing(11);
    landing(12);
    queue('AISDLC-1');
    const s = openPrState(board, { AI_SDLC_OPEN_PR_LIMIT: '3' });
    expect(s.ceiling).toBe(6);
    expect(s.counted.length).toBe(2);
    expect(s.atLimit).toBe(true);
    await runDispatchTick(deps({}, 3));
    expect(spawns).toEqual([]);
  });

  it('4 re-entering + 1 delivered claims a new task (2026-11-07 regression)', async () => {
    reenter(4);
    landing(11);
    queue('AISDLC-1');
    await runDispatchTick(deps({}, 3));
    expect(spawns).toEqual(['AISDLC-1']);
  });

  it('four re-entering PRs at limit 3 do not block a new queued task', async () => {
    reenter(4);
    queue('AISDLC-1');
    await runDispatchTick(deps({}, 3));
    expect(spawns).toEqual(['AISDLC-1']);
  });
});

describe('reconcile lock (AC-6)', () => {
  it('refuses a second holder, takes over a stale lock, and releases', async () => {
    const now = new Date(clock);
    expect(acquireReconcileLock(board, now)).toBe(true);
    expect(acquireReconcileLock(board, now)).toBe(false);
    const inner = await withReconcileLock(board, now, () => 1);
    expect(inner).toEqual({ ran: false });
    const later = new Date(clock + RECONCILE_LOCK_STALE_MS + 1);
    expect(acquireReconcileLock(board, later)).toBe(true);
    releaseReconcileLock(board);
    const ok = await withReconcileLock(board, now, () => 7);
    expect(ok).toEqual({ ran: true, value: 7 });
    expect(acquireReconcileLock(board, now)).toBe(true);
  });

  it('the tick skips its pass while the watch holds the lock', async () => {
    acquireReconcileLock(board, new Date(clock));
    let ran = false;
    queue('AISDLC-1');
    await runDispatchTick(deps({ reconcileNow: () => void (ran = true) }));
    expect(ran).toBe(false);
    expect(spawns).toEqual(['AISDLC-1']);
  });

  it('treats an unreadable lock as stale', () => {
    writeFileSync(path.join(board, 'reconcile.lock'), 'junk');
    expect(acquireReconcileLock(board, new Date(clock))).toBe(true);
  });
});
