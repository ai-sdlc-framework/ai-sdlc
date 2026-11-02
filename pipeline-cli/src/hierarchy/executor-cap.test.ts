import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueTasks } from '../dispatch/enqueue.js';
import type { BudgetStatus, WindowPace } from './budget.js';
import {
  computeCap,
  DEFAULT_EXECUTORS_MAX,
  executorCap,
  formatExecutorCap,
  pacerAllowance,
  resolveExecutorsMax,
} from './executor-cap.js';
import {
  spawnForEligibleClaims,
  type EphemeralDeps,
  type EphemeralReport,
} from './ephemeral-tick.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'exec-cap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pace = (ahead: number, margin = 2): WindowPace => ({
  name: 'sevenDay',
  utilization: 50,
  line: 50 - ahead,
  ahead,
  margin,
  resetsAt: 'x',
});
const budget = (ahead: number, overridden = false): BudgetStatus => ({
  at: 'x',
  sevenDay: pace(ahead),
  overridden,
});

describe('executors.max', () => {
  it('defaults, reads config, and env wins', () => {
    expect(resolveExecutorsMax(dir)).toBe(DEFAULT_EXECUTORS_MAX);
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ executors: { max: 5 } }));
    expect(resolveExecutorsMax(dir)).toBe(5);
    expect(resolveExecutorsMax(dir, { AI_SDLC_EXECUTORS_MAX: '2' })).toBe(2);
    expect(resolveExecutorsMax(dir, { AI_SDLC_EXECUTORS_MAX: 'zero' })).toBe(5);
    writeFileSync(path.join(dir, 'config.json'), '{bad');
    expect(resolveExecutorsMax(dir)).toBe(DEFAULT_EXECUTORS_MAX);
  });
});

describe('pacer allowance and cap', () => {
  it('maps pace to allowance', () => {
    expect(pacerAllowance(undefined)).toBe(Infinity);
    expect(pacerAllowance(budget(10, true))).toBe(Infinity);
    expect(pacerAllowance(budget(10))).toBe(0);
    expect(pacerAllowance(budget(0))).toBe(1);
    expect(pacerAllowance(budget(-10))).toBe(Infinity);
    expect(pacerAllowance({ at: 'x', overridden: false })).toBe(Infinity);
  });

  it('is min of max and allowance, never below one while any work is allowed', () => {
    expect(computeCap(3, Infinity)).toBe(3);
    expect(computeCap(3, 1)).toBe(1);
    expect(computeCap(3, 0)).toBe(0);
    expect(computeCap(2, 0.4)).toBe(1);
    expect(executorCap(dir, 0, {}, budget(0))).toEqual({
      max: 3,
      allowance: 1,
      headroom: Infinity,
      cap: 1,
      winner: 'pacer allowance',
    });
    expect(executorCap(dir, 0, {}).cap).toBe(3);
  });

  it('formats the status line', () => {
    expect(
      formatExecutorCap({
        max: 3,
        allowance: Infinity,
        headroom: Infinity,
        cap: 3,
        winner: 'executors.max',
      }),
    ).toBe(
      'EXECUTOR CAP 3 (executors.max 3, board ceiling none, pacer allowance unlimited, load headroom unlimited; limited by executors.max)',
    );
    expect(
      formatExecutorCap({
        max: 3,
        allowance: 1,
        headroom: Infinity,
        cap: 1,
        winner: 'pacer allowance',
      }),
    ).toContain('pacer allowance 1,');
  });

  it('the tick never spawns above min(max, allowance) with a stubbed pacer', async () => {
    const spawned: string[] = [];
    const deps: EphemeralDeps = {
      down: async () => ({ ok: true }),
      spawn: async (id) => {
        spawned.push(id);
      },
      cap: () => computeCap(4, 2),
    };
    const out: EphemeralReport = { downed: [], spawned: [], spawnErrors: [] };
    enqueueTasks(
      dir,
      ['AISDLC-1', 'AISDLC-2', 'AISDLC-3', 'AISDLC-4'].map((taskId) => ({ taskId, wave: 1 })),
      {
        baseSha: 'abc1234',
        dispatchedBy: 'operator-dispatch',
        resolveTaskFile: (id) => `backlog/tasks/${id.toLowerCase()}.md`,
      },
    );
    await spawnForEligibleClaims(dir, deps, () => new Date(0), out);
    expect(spawned).toHaveLength(2);
  });
});
