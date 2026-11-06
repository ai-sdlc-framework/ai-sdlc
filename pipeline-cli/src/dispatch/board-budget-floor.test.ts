import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { runBudgetPacer, type UsageDeps } from '../hierarchy/budget.js';
import { claimNext } from './board.js';
import { enqueueTasks } from './enqueue.js';

const T0 = Date.parse('2026-10-23T18:30:00Z');
const RESET7 = '2026-10-27T18:30:00Z';

let root: string;
let board: string;
let clock: number;
let seven: number;

function deps(): UsageDeps {
  return {
    readToken: () => 'sk-test',
    now: () => new Date(clock),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ seven_day: { utilization: seven, resets_at: RESET7 } }),
    }),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'floor-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(board, { recursive: true });
  for (const [id, pri] of [
    ['AISDLC-1', 'low'],
    ['AISDLC-2', 'medium'],
    ['AISDLC-3', 'high'],
  ] as const) {
    writeFileSync(
      path.join(root, 'backlog', 'tasks', `${id} - t.md`),
      `---\nid: ${id}\ntitle: t\nstatus: To Do\npriority: ${pri}\n---\n`,
    );
  }
  enqueueTasks(
    board,
    ['AISDLC-1', 'AISDLC-2', 'AISDLC-3'].map((taskId) => ({ taskId })),
    {
      baseSha: 'abc',
      dispatchedBy: 'test',
      workDir: root,
      resolveTaskFile: (id) => `backlog/tasks/${id} - t.md`,
    },
  );
  clock = T0;
  seven = 50;
});
afterEach(() => removeFixtureDir(root));

async function sample(utilization: number, at: number): Promise<void> {
  seven = utilization;
  clock = at;
  await runBudgetPacer(board, deps());
}

describe('claimNext honours the budget priority floor (RFC-0062 OQ-1)', () => {
  it('claims only high tasks while the projection passes 100%, then resumes', async () => {
    writeFileSync(
      path.join(board, 'config.json'),
      JSON.stringify({ budget: { priorityFloor: 'high', marginPoints: 100 } }),
    );
    await sample(50, T0);
    await sample(60, T0 + 3600_000 + 6 * 60_000);
    const now = () => new Date(clock);
    const first = claimNext(board, 'in-session-agent', now);
    expect(first.claimed && first.manifest?.taskId).toBe('AISDLC-3');
    expect(claimNext(board, 'in-session-agent', now).claimed).toBe(false);
    // Recovery: utilization back under the first sample, no projection.
    await sample(40, clock + 6 * 60_000);
    // A low task is claimable again.
    const resumed = claimNext(board, 'in-session-agent', now);
    expect(resumed.claimed && resumed.manifest?.taskId).toBe('AISDLC-1');
  });

  it('claims critical and highest tasks under a high floor', async () => {
    for (const [id, pri] of [
      ['AISDLC-4', 'critical'],
      ['AISDLC-5', 'highest'],
    ] as const) {
      writeFileSync(
        path.join(root, 'backlog', 'tasks', `${id} - t.md`),
        `---\nid: ${id}\ntitle: t\nstatus: To Do\npriority: ${pri}\n---\n`,
      );
    }
    enqueueTasks(board, [{ taskId: 'AISDLC-4' }, { taskId: 'AISDLC-5' }], {
      baseSha: 'abc',
      dispatchedBy: 'test',
      workDir: root,
      resolveTaskFile: (id) => `backlog/tasks/${id} - t.md`,
    });
    writeFileSync(
      path.join(board, 'config.json'),
      JSON.stringify({ budget: { priorityFloor: 'high', marginPoints: 100 } }),
    );
    await sample(50, T0);
    await sample(60, T0 + 3600_000 + 6 * 60_000);
    const now = () => new Date(clock);
    const claimed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = claimNext(board, 'in-session-agent', now);
      if (r.claimed && r.manifest) claimed.push(r.manifest.taskId);
    }
    expect(claimed.sort()).toEqual(['AISDLC-3', 'AISDLC-4', 'AISDLC-5']);
  });

  it('with the default none, claims are unrestricted under the same pressure', async () => {
    await sample(50, T0);
    await sample(60, T0 + 3600_000 + 6 * 60_000);
    const r = claimNext(board, 'in-session-agent', () => new Date(clock));
    expect(r.claimed).toBe(true);
  });
});
