/** Ephemeral executors in the dispatch tick (RFC-0059, AISDLC-1074). */

import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeHeartbeat, writeVerdict } from '../dispatch/board.js';
import { enqueueTasks } from '../dispatch/enqueue.js';
import { requeueFailed } from '../dispatch/requeue.js';
import { readLoopState, runDispatchTick, type LoopDeps } from './dispatch-loop.js';
import { readRosterChecked, writeRoster } from './roster.js';
import type { RosterEntry } from './types.js';
import { spawnedExecutorName } from './validate.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const MIN = 60_000;
let tmp: string;
let board: string;
let clock: number;
let downs: string[];
let spawns: string[];

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
    startedAt: new Date(clock - 60 * MIN).toISOString(),
    status: 'running',
  }) as RosterEntry;

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    boardDir: board,
    workerId: 'operator-dispatch',
    now: () => new Date(clock),
    enqueue: () => [],
    clear: async (o) => ({ executor: o.executor, ok: true, settleMs: 0 }),
    playbook: (v) => ({ taskId: v.taskId, action: 'requeue', result: 'done', reason: 'ok' }),
    operational: new Set(['clear-executor-context', 'requeue']),
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
      cap: () => 2,
    },
    ...over,
  };
}

function queue(taskId: string): void {
  enqueueTasks(board, [{ taskId, wave: 1 }], {
    baseSha: 'abc1234',
    dispatchedBy: 'operator-dispatch',
    resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()}.md`,
  });
}

function claim(taskId: string, worker: string, ageMs: number): void {
  queue(taskId);
  mkdirSync(path.join(board, 'inflight'), { recursive: true });
  renameSync(
    path.join(board, 'queue', `${taskId}.dispatch.json`),
    path.join(board, 'inflight', `${taskId}.dispatch.json`),
  );
  const at = new Date(clock - ageMs).toISOString();
  writeHeartbeat(board, {
    taskId,
    workerId: worker,
    workerKind: 'in-session-agent',
    currentStep: '05-dev-running',
    startedAt: at,
    lastHeartbeat: at,
  });
}

function verdictAt(taskId: string, at: number, outcome: 'success' | 'failed' = 'success'): void {
  writeVerdict(board, {
    schemaVersion: 'v1',
    taskId,
    outcome,
    completedAt: new Date(at).toISOString(),
    workerId: spawnedExecutorName(taskId),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'dispatch-ephemeral-'));
  board = path.join(tmp, 'dispatch');
  mkdirSync(board, { recursive: true });
  clock = Date.parse('2026-10-27T12:00:00.000Z');
  downs = [];
  spawns = [];
});
afterEach(() => removeFixtureDir(tmp));

describe('ephemeral executors in the tick', () => {
  it('downs the executor of a verdict recorded this tick and removes its roster entry', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    verdictAt('AISDLC-71', clock - MIN);
    const r = await runDispatchTick(deps());
    expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
    expect(r.ephemeral?.downed[0]).toMatchObject({ taskId: 'AISDLC-71', why: 'verdict', ok: true });
    expect(readRosterChecked(board).roster.sessions).toHaveLength(0);
  });

  it('leaves a static executor to the clear path', async () => {
    const st = {
      ...entry('AISDLC-71'),
      name: 'executor-alpha',
      tmuxSession: 'ai-sdlc-hierarchy',
      tmuxWindow: 'executor-alpha',
      taskId: undefined,
    } as RosterEntry;
    writeRoster(board, { schemaVersion: 'v1', sessions: [st] });
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-71',
      outcome: 'success',
      completedAt: new Date(clock).toISOString(),
      workerId: 'executor-alpha',
    });
    const r = await runDispatchTick(deps());
    expect(downs).toEqual([]);
    expect(r.verdicts[0]?.clear.status).toBe('cleared');
  });

  it('sweeps an executor still alive 5 minutes after its verdict', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    verdictAt('AISDLC-71', clock - 6 * MIN);
    // The verdict was handled by an earlier tick.
    await runDispatchTick(
      deps({
        ephemeral: { ...deps().ephemeral!, down: async () => ({ ok: false, reason: 'busy' }) },
      }),
    );
    downs = [];
    const r = await runDispatchTick(deps());
    expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
    expect(r.ephemeral?.downed[0]?.why).toBe('sweep');
  });

  it('does not sweep before 5 minutes, nor on a verdict older than the executor', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71'), entry('AISDLC-72')] });
    verdictAt('AISDLC-71', clock - 4 * MIN);
    verdictAt('AISDLC-72', clock - 90 * MIN);
    await runDispatchTick(
      deps({ ephemeral: { ...deps().ephemeral!, down: async () => ({ ok: false }) } }),
    );
    downs = [];
    await runDispatchTick(deps());
    expect(downs).toEqual([]);
  });

  it('downs a crashed executor (no heartbeat for 30 minutes) and requeues its manifest', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    claim('AISDLC-71', 'ai-sdlc-executor-aisdlc-71', 31 * MIN);
    const requeued: string[] = [];
    const r = await runDispatchTick(
      deps({
        stall: {
          requeue: (id) => {
            requeued.push(id);
            requeueFailed(board, id, {});
          },
        },
      }),
    );
    expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
    expect(requeued).toEqual(['AISDLC-71']);
    expect(r.stalled?.[0]?.clear?.status).toBe('downed');
  });

  it('keeps an executor with a fresh heartbeat', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    claim('AISDLC-71', 'ai-sdlc-executor-aisdlc-71', 2 * MIN);
    await runDispatchTick(deps({ stall: {} }));
    expect(downs).toEqual([]);
  });

  it('spawns per eligible claim up to the cap, after downing', async () => {
    queue('AISDLC-80');
    queue('AISDLC-81');
    queue('AISDLC-82');
    const r = await runDispatchTick(deps());
    expect(spawns).toHaveLength(2);
    expect(r.ephemeral?.spawned).toEqual(spawns);
  });

  it('counts live executors against the cap and records spawn failures', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    queue('AISDLC-80');
    queue('AISDLC-81');
    const failing = deps();
    failing.ephemeral!.spawn = async () => {
      throw new Error('tmux down');
    };
    const r = await runDispatchTick(failing);
    expect(r.ephemeral?.spawnErrors).toHaveLength(2);
    expect(r.ephemeral?.spawned).toEqual([]);
    expect(readLoopState(board).lastSpawnErrors).toHaveLength(2);
  });

  it('reaps orphaned executor sessions and lists them in the result (AISDLC-1117)', async () => {
    const d = deps();
    d.ephemeral!.reapOrphans = () => ['ai-sdlc-executor-aisdlc-9'];
    const r = await runDispatchTick(d);
    expect(r.ephemeral?.orphansReaped).toEqual(['ai-sdlc-executor-aisdlc-9']);
  });

  it('does nothing while held', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    verdictAt('AISDLC-71', clock - 10 * MIN);
    queue('AISDLC-80');
    const { writeHold } = await import('./hold.js');
    writeHold(board, { reason: 'test', by: 'planner', at: new Date(clock).toISOString() } as never);
    const r = await runDispatchTick(deps());
    expect(downs).toEqual([]);
    expect(spawns).toEqual([]);
    expect(r.ephemeral).toBeUndefined();
  });
});
