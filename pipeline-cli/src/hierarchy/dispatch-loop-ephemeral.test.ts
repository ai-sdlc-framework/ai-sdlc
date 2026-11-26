/** Ephemeral executors in the dispatch tick (RFC-0059, AISDLC-1074). */

import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeHeartbeat, writeManifest, writeVerdict } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { enqueueTasks } from '../dispatch/enqueue.js';
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

function queueWith(taskId: string, extra: Partial<DispatchManifest>): void {
  writeManifest(board, {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-10-27T11:00:00.000Z',
    dispatchedBy: 'operator-dispatch',
    spec: { taskFile: 'x.md', verifyCommands: ['pnpm build'] },
    ...extra,
  });
}

function claim(
  taskId: string,
  worker: string,
  ageMs: number,
  phase: 'awaiting-developer' | 'done' = 'awaiting-developer',
): void {
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
    phase,
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

  it('retries a failed down on the next tick, with no grace delay (AISDLC-1417)', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    verdictAt('AISDLC-71', clock - MIN);
    // The verdict was handled by an earlier tick whose down failed.
    await runDispatchTick(
      deps({
        ephemeral: { ...deps().ephemeral!, down: async () => ({ ok: false, reason: 'busy' }) },
      }),
    );
    downs = [];
    const r = await runDispatchTick(deps());
    expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
    expect(r.ephemeral?.downed[0]?.why).toBe('verdict');
  });

  it('downs an executor idle with its claim and re-queues the task (AISDLC-1218)', async () => {
    writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
    claim('AISDLC-71', 'ai-sdlc-executor-aisdlc-71', 31 * MIN, 'done');
    const r = await runDispatchTick(deps({ stall: {} }));
    expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
    expect(r.stalled?.[0]?.clear?.status).toBe('downed');
  });

  it('keeps a running executor with a fresh heartbeat', async () => {
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

  describe('sequence groups (AISDLC-1330)', () => {
    const wide = () => {
      const d = deps();
      d.ephemeral!.cap = () => 3;
      return d;
    };

    it('starts one task per group and the ungrouped task', async () => {
      queueWith('AISDLC-101', { sequenceGroup: 'g', priority: 1 });
      queueWith('AISDLC-102', { sequenceGroup: 'g', priority: 1 });
      queueWith('AISDLC-103', { sequenceGroup: 'g', priority: 2 });
      queueWith('AISDLC-120', { priority: 2 });
      await runDispatchTick(wide());
      expect(spawns).toHaveLength(2);
      expect(spawns).toContain('AISDLC-120');
      expect(spawns.filter((t) => t.startsWith('AISDLC-10'))).toHaveLength(1);
    });

    it('starts none of a group held by an inflight task and gives the slot on', async () => {
      queueWith('AISDLC-111', { sequenceGroup: 'g' });
      mkdirSync(path.join(board, 'inflight'), { recursive: true });
      renameSync(
        path.join(board, 'queue', 'AISDLC-111.dispatch.json'),
        path.join(board, 'inflight', 'AISDLC-111.dispatch.json'),
      );
      queueWith('AISDLC-112', { sequenceGroup: 'g' });
      queueWith('AISDLC-113', { sequenceGroup: 'g' });
      queueWith('AISDLC-120', {});
      await runDispatchTick(wide());
      expect(spawns).toEqual(['AISDLC-120']);
    });

    it('starts no second member while an executor for the group has not claimed', async () => {
      writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-101')] });
      queueWith('AISDLC-101', { sequenceGroup: 'g' });
      queueWith('AISDLC-102', { sequenceGroup: 'g' });
      queueWith('AISDLC-120', {});
      await runDispatchTick(wide());
      expect(spawns).toEqual(['AISDLC-120']);
    });

    it('starts an ungrouped task whatever the group state', async () => {
      queueWith('AISDLC-101', { sequenceGroup: 'g' });
      queueWith('AISDLC-120', {});
      await runDispatchTick(wide());
      expect(spawns.sort()).toEqual(['AISDLC-101', 'AISDLC-120']);
    });
  });

  it('spawns nothing for a task no executor may claim and reports the reason once (AISDLC-1121)', async () => {
    enqueueTasks(board, [{ taskId: 'AISDLC-90', wave: 1 }], {
      baseSha: 'abc1234',
      dispatchedBy: 'operator-dispatch',
      resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()}.md`,
      workerKind: 'claude-p-shell',
    });
    const r = await runDispatchTick(deps());
    expect(spawns).toEqual([]);
    expect(r.ephemeral?.unclaimable?.map((u) => u.taskId)).toEqual(['AISDLC-90']);
    const again = await runDispatchTick(deps());
    expect(spawns).toEqual([]);
    expect(again.ephemeral?.unclaimable ?? []).toEqual([]);
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

  describe('teardown is not gated by any hold (AISDLC-1417)', () => {
    const hold = async (by = 'planner', reason = 'test'): Promise<void> => {
      const { writeHold } = await import('./hold.js');
      writeHold(board, { reason, by, since: new Date(clock).toISOString() });
    };
    const lowQuota: Partial<LoopDeps> = { quota: () => ({ core: 1 }), quotaFloor: 500 };
    type Case = readonly [string, () => Promise<void>, Partial<LoopDeps>];

    it('downs a finished executor and consumes its success verdict while held', async () => {
      writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
      verdictAt('AISDLC-71', clock - 10 * MIN);
      queue('AISDLC-80');
      await hold();
      const r = await runDispatchTick(deps());
      expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
      expect(readRosterChecked(board).roster.sessions).toHaveLength(0);
      expect(r.ephemeral?.downed[0]).toMatchObject({
        taskId: 'AISDLC-71',
        why: 'verdict',
        ok: true,
      });
      expect(r.verdicts[0]?.clear.reason).toBe('ephemeral executor: downed');
      expect(readLoopState(board).handled).toContain(
        `done:AISDLC-71:${new Date(clock - 10 * MIN).toISOString()}`,
      );
      // The hold still gates the spawn.
      expect(spawns).toEqual([]);
      expect(r.ephemeral?.spawned).toEqual([]);
    });

    it.each([
      ['a budget-pacer hold', () => hold('pacer', 'budget: 7d at 91%'), {}],
      ['a quota skip', async () => undefined, lowQuota],
    ] as Case[])('downs a finished executor under %s and spawns nothing', async (_n, set, over) => {
      writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
      verdictAt('AISDLC-71', clock - MIN);
      queue('AISDLC-80');
      await set();
      const r = await runDispatchTick(deps(over));
      expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
      expect(readRosterChecked(board).roster.sessions).toHaveLength(0);
      expect(spawns).toEqual([]);
      expect(r.ephemeral?.spawned).toEqual([]);
    });

    it.each([
      ['no hold', async () => undefined, {}],
      ['a planner hold', () => hold(), {}],
      ['a budget-pacer hold', () => hold('pacer', 'budget: x'), {}],
      ['a quota skip', async () => undefined, lowQuota],
    ] as Case[])(
      'keeps an executor with an inflight claim or a stale verdict under %s',
      async (_n, set, over) => {
        writeRoster(board, {
          schemaVersion: 'v1',
          sessions: [entry('AISDLC-71'), entry('AISDLC-72')],
        });
        // AISDLC-71: an iterate-needed verdict keeps the claim inflight.
        claim('AISDLC-71', 'ai-sdlc-executor-aisdlc-71', MIN);
        writeVerdict(board, {
          schemaVersion: 'v1',
          taskId: 'AISDLC-71',
          outcome: 'iterate-needed',
          completedAt: new Date(clock - MIN).toISOString(),
          workerId: 'ai-sdlc-executor-aisdlc-71',
        });
        // AISDLC-72: the verdict predates the executor's start (an earlier attempt).
        verdictAt('AISDLC-72', clock - 90 * MIN);
        await set();
        await runDispatchTick(deps(over));
        expect(downs).toEqual([]);
        expect(readRosterChecked(board).roster.sessions).toHaveLength(2);
      },
    );

    it('reaps orphans and downs idle surplus while held', async () => {
      writeRoster(board, {
        schemaVersion: 'v1',
        sessions: [entry('AISDLC-71'), entry('AISDLC-72')],
      });
      await hold();
      const d = deps({ idleExecutors: () => ['ai-sdlc-executor-aisdlc-72'] });
      d.ephemeral!.cap = () => 1;
      d.ephemeral!.reapOrphans = () => ['ai-sdlc-executor-aisdlc-9'];
      const first = await runDispatchTick(d);
      expect(first.ephemeral?.orphansReaped).toEqual(['ai-sdlc-executor-aisdlc-9']);
      expect(downs).toEqual([]);
      const second = await runDispatchTick(d);
      expect(downs).toEqual(['ai-sdlc-executor-aisdlc-72']);
      expect(second.ephemeral?.downed[0]).toMatchObject({ why: 'surplus', ok: true });
    });

    it('stops a failed executor while held, with no playbook and one planner notice', async () => {
      writeRoster(board, { schemaVersion: 'v1', sessions: [entry('AISDLC-71')] });
      verdictAt('AISDLC-71', clock - MIN, 'failed');
      await hold();
      let playbooks = 0;
      const d = deps({
        playbook: (v) => {
          playbooks += 1;
          return { taskId: v.taskId, action: 'requeue', result: 'done', reason: 'ok' };
        },
      });
      const r = await runDispatchTick(d);
      expect(downs).toEqual(['ai-sdlc-executor-aisdlc-71']);
      expect(playbooks).toBe(0);
      expect(r.escalations.filter((e) => e.taskId === 'AISDLC-71')).toHaveLength(1);
      expect(r.verdicts[0]?.clear.reason).toBe('the board is held: test');
      const again = await runDispatchTick(d);
      expect(again.escalations.filter((e) => e.taskId === 'AISDLC-71')).toHaveLength(0);
      expect(playbooks).toBe(0);
    });
  });
});
