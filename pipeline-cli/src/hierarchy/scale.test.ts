/** The runtime ceiling and the four-input cap (AISDLC-1083). */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueTasks } from '../dispatch/enqueue.js';
import { writeHeartbeat } from '../dispatch/board.js';
import type { BudgetStatus } from './budget.js';
import { runDispatchTick, type LoopDeps } from './dispatch-loop.js';
import { executorCap, formatExecutorCap, loadHeadroom } from './executor-cap.js';
import { readRosterChecked, writeRoster } from './roster.js';
import {
  clearScaleCeiling,
  readScaleCeiling,
  SCALE_FILENAME,
  SCALE_LOG_FILENAME,
  writeScaleCeiling,
} from './scale.js';
import type { ResourceSnapshot, RosterEntry } from './types.js';
import { spawnedExecutorName } from './validate.js';

const GIB = 1024 ** 3;
const calm: ResourceSnapshot = { availableBytes: 16 * GIB, loadAvg1: 0, cpus: 8 };
const saturated: ResourceSnapshot = { availableBytes: 16 * GIB, loadAvg1: 8, cpus: 8 };
const behind: BudgetStatus = { at: 'x', overridden: true };
const inBand: BudgetStatus = {
  at: 'x',
  overridden: false,
  sevenDay: { name: 'sevenDay', utilization: 50, line: 50, ahead: 0, margin: 2, resetsAt: 'x' },
};

let tmp: string;
let board: string;
let spawns: string[];
let downs: string[];
let snapshot: ResourceSnapshot;
let pacer: BudgetStatus;
const clock = Date.parse('2026-11-01T12:00:00Z');

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'scale-'));
  board = path.join(tmp, 'board');
  mkdirSync(board, { recursive: true });
  spawns = [];
  downs = [];
  snapshot = calm;
  pacer = behind;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const entry = (taskId: string): RosterEntry =>
  ({
    role: 'executor',
    name: spawnedExecutorName(taskId),
    taskId,
    tmuxSession: spawnedExecutorName(taskId),
    tmuxWindow: spawnedExecutorName(taskId),
    paneId: '%1',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: new Date(clock - 3600_000).toISOString(),
    status: 'running',
  }) as RosterEntry;

function queue(...ids: string[]): void {
  enqueueTasks(
    board,
    ids.map((taskId) => ({ taskId, wave: 1 })),
    {
      baseSha: 'abc1234',
      dispatchedBy: 'operator-dispatch',
      resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()}.md`,
    },
  );
}

function inflight(taskId: string, worker: string): void {
  queue(taskId);
  mkdirSync(path.join(board, 'inflight'), { recursive: true });
  renameSync(
    path.join(board, 'queue', `${taskId}.dispatch.json`),
    path.join(board, 'inflight', `${taskId}.dispatch.json`),
  );
  writeHeartbeat(board, {
    taskId,
    workerId: worker,
    at: new Date(clock).toISOString(),
    note: 'working',
  } as never);
}

function roster(...ids: string[]): void {
  writeRoster(board, { schemaVersion: 'v1', sessions: ids.map(entry) } as never);
}

function deps(idle: () => string[] = () => []): LoopDeps {
  return {
    boardDir: board,
    workerId: 'operator-dispatch',
    now: () => new Date(clock),
    enqueue: () => [],
    clear: async (o) => ({ executor: o.executor, ok: true, settleMs: 0 }),
    playbook: (v) => ({ taskId: v.taskId, action: 'requeue', result: 'done', reason: 'ok' }),
    operational: new Set(['clear-executor-context', 'requeue']),
    idleExecutors: idle,
    ephemeral: {
      down: async (name) => {
        downs.push(name);
        const r = readRosterChecked(board).roster;
        writeRoster(board, { ...r, sessions: r.sessions.filter((s) => s.name !== name) });
        return { ok: true };
      },
      spawn: async (id) => {
        spawns.push(id);
      },
      cap: (live) =>
        executorCap(board, clock, {}, pacer, { resources: snapshot, live: live ?? 0 }).cap,
    },
  };
}

describe('scale ceiling file', () => {
  it('writes, reads, logs and clears', () => {
    expect(readScaleCeiling(board)).toBeNull();
    writeScaleCeiling(board, { max: 2, reason: 'x', since: 's', by: 'planner' });
    expect(readScaleCeiling(board)).toMatchObject({ max: 2, by: 'planner' });
    expect(clearScaleCeiling(board, 'planner', 't')?.max).toBe(2);
    expect(clearScaleCeiling(board, 'planner', 't')).toBeNull();
    const log = readFileSync(path.join(board, SCALE_LOG_FILENAME), 'utf-8').trim().split('\n');
    expect(log.map((l) => JSON.parse(l).event)).toEqual(['scale', 'scale-clear']);
  });

  it('ignores a malformed or non-positive ceiling', () => {
    writeFileSync(path.join(board, SCALE_FILENAME), '{bad');
    expect(readScaleCeiling(board)).toBeNull();
    writeFileSync(path.join(board, SCALE_FILENAME), JSON.stringify({ max: 0 }));
    expect(readScaleCeiling(board)).toBeNull();
    writeFileSync(path.join(board, SCALE_FILENAME), JSON.stringify({ max: 2 }));
    expect(readScaleCeiling(board)).toMatchObject({ max: 2, reason: '', by: '' });
  });
});

describe('cap winner', () => {
  const env = { AI_SDLC_EXECUTORS_MAX: '4' };
  it('names each input when it is the minimum', () => {
    expect(executorCap(board, clock, env, behind).winner).toBe('executors.max');
    writeScaleCeiling(board, { max: 2, reason: 'x', since: 's', by: 'p' });
    expect(executorCap(board, clock, env, behind)).toMatchObject({
      cap: 2,
      winner: 'board ceiling',
    });
    clearScaleCeiling(board, 'p', 't');
    expect(executorCap(board, clock, env, inBand)).toMatchObject({
      cap: 1,
      winner: 'pacer allowance',
    });
    const low: ResourceSnapshot = { ...calm, loadAvg1: 6 };
    expect(executorCap(board, clock, env, behind, { resources: low, live: 1 })).toMatchObject({
      cap: 3,
      winner: 'load headroom',
    });
    expect(executorCap(board, clock, env, behind, { resources: saturated })).toMatchObject({
      cap: 0,
      winner: 'load headroom',
    });
  });

  it('treats low memory as saturation and prints all four inputs', () => {
    expect(loadHeadroom({ ...calm, availableBytes: GIB }, 0)).toBe(0);
    expect(loadHeadroom({ ...calm, availableBytes: null }, 0)).toBe(8);
    expect(loadHeadroom(undefined, 0)).toBe(Infinity);
    writeScaleCeiling(board, { max: 1, reason: 'x', since: 's', by: 'p' });
    expect(formatExecutorCap(executorCap(board, clock, env, behind, { resources: calm }))).toBe(
      'EXECUTOR CAP 1 (executors.max 4, board ceiling 1, pacer allowance unlimited, load headroom 8; limited by board ceiling)',
    );
  });
});

describe('the tick never spawns above the four-input minimum', () => {
  const run = async (): Promise<void> => {
    await runDispatchTick(deps());
  };
  beforeEach(() => {
    queue('AISDLC-1', 'AISDLC-2', 'AISDLC-3', 'AISDLC-4', 'AISDLC-5');
    writeFileSync(path.join(board, 'config.json'), JSON.stringify({ executors: { max: 4 } }));
  });

  it('executors.max is the minimum', async () => {
    await run();
    expect(spawns).toHaveLength(4);
  });
  it('the board ceiling is the minimum', async () => {
    writeScaleCeiling(board, { max: 2, reason: 'x', since: 's', by: 'p' });
    await run();
    expect(spawns).toHaveLength(2);
  });
  it('the pacer allowance is the minimum', async () => {
    pacer = inBand;
    await run();
    expect(spawns).toHaveLength(1);
  });
  it('the load headroom is the minimum', async () => {
    snapshot = { ...calm, loadAvg1: 6 };
    await run();
    expect(spawns).toHaveLength(2);
  });
  it('a saturated machine spawns nothing', async () => {
    snapshot = saturated;
    await run();
    expect(spawns).toEqual([]);
  });
});

describe('shrinking under saturation', () => {
  it('downs only idle executors, and only after two ticks', async () => {
    roster('AISDLC-1', 'AISDLC-2');
    inflight('AISDLC-1', spawnedExecutorName('AISDLC-1'));
    snapshot = saturated;
    const idle = () => [spawnedExecutorName('AISDLC-2')];
    await runDispatchTick(deps(idle));
    expect(downs).toEqual([]);
    await runDispatchTick(deps(idle));
    expect(downs).toEqual([spawnedExecutorName('AISDLC-2')]);
    expect(spawns).toEqual([]);
  });

  it('a recovered cap resets the streak', async () => {
    roster('AISDLC-2');
    snapshot = saturated;
    const idle = () => [spawnedExecutorName('AISDLC-2')];
    await runDispatchTick(deps(idle));
    snapshot = calm;
    await runDispatchTick(deps(idle));
    snapshot = saturated;
    await runDispatchTick(deps(idle));
    expect(downs).toEqual([]);
  });
});
