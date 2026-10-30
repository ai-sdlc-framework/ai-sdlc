import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { peekQueue } from '../dispatch/board.js';
import { writeHold } from './hold.js';
import {
  advanceCanaryRun,
  canaryDue,
  isCanaryTask,
  listCanaryRuns,
  markCanaryDue,
  runningCanary,
  startCanaryRun,
  writeClearStamp,
} from './loop-canary.js';
import { runLoopCanaryCommand } from './loop-canary-run.js';

let root: string;
let board: string;
let clock: number;
const now = (): Date => new Date(clock);
const MIN = 60_000;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'loop-canary-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  clock = Date.parse('2026-10-28T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function start() {
  return startCanaryRun({
    boardDir: board,
    workDir: root,
    baseSha: 'a'.repeat(40),
    dispatchedBy: 'dispatch',
    now,
  });
}

/** Play the executor and dispatch: claim, verdict, handled, optional clear stamp. */
function play(taskId: string, o: { stamp: boolean; verdict?: boolean }): void {
  const q = path.join(board, 'queue', `${taskId}.dispatch.json`);
  const inflight = path.join(board, 'inflight');
  mkdirSync(inflight, { recursive: true });
  const m = JSON.parse(readFileSync(q, 'utf-8'));
  rmSync(q);
  writeFileSync(
    path.join(inflight, `${taskId}.dispatch.json`),
    JSON.stringify({ ...m, workerId: 'exec-1' }),
  );
  if (o.verdict === false) return;
  const completedAt = now().toISOString();
  mkdirSync(path.join(board, 'done'), { recursive: true });
  writeFileSync(
    path.join(board, 'done', `${taskId}.verdict.json`),
    JSON.stringify({ taskId, workerId: 'exec-1', outcome: 'success', completedAt }),
  );
  writeFileSync(
    path.join(board, 'operator-dispatch.state.json'),
    JSON.stringify({ handled: [`done:${taskId}:${completedAt}`] }),
  );
  if (o.stamp) {
    clock += 1000;
    writeClearStamp(board, 'exec-1', now());
  }
}

describe('loop canary', () => {
  it('passes when all five stages are reached in order', () => {
    const run = start();
    expect(isCanaryTask(run.taskId)).toBe(true);
    play(run.taskId, { stamp: true });
    expect(advanceCanaryRun(board, run, now()).finished).toBeUndefined();
    play(run.followTaskId, { stamp: false, verdict: false });
    const r = advanceCanaryRun(board, run, now());
    expect(r.finished).toBe('pass');
    expect(Object.keys(r.run.stages)).toHaveLength(5);
    expect(listCanaryRuns(board)[0]?.status).toBe('pass');
  });

  it('fails naming executorCleared when the clear stamp is never written', () => {
    const run = start();
    play(run.taskId, { stamp: false });
    expect(advanceCanaryRun(board, run, now()).finished).toBeUndefined();
    clock += 11 * MIN;
    const r = advanceCanaryRun(board, run, now());
    expect(r.finished).toBe('fail');
    expect(r.run.failedStage).toBe('executorCleared');
    expect(r.message).toContain('executorCleared');
    expect(runningCanary(board)).toBeUndefined();
  });

  it('fails at claimed when nobody claims, and retires the queued probes', () => {
    const run = start();
    clock += 16 * MIN;
    const r = advanceCanaryRun(board, run, now());
    expect(r.run.failedStage).toBe('claimed');
    expect(peekQueue(board).queued).toBe(0);
  });

  it('fails at developed on a failed verdict', () => {
    const run = start();
    play(run.taskId, { stamp: false, verdict: false });
    mkdirSync(path.join(board, 'failed'), { recursive: true });
    writeFileSync(path.join(board, 'failed', `${run.taskId}.verdict.json`), '{}');
    expect(advanceCanaryRun(board, run, now()).run.failedStage).toBe('developed');
  });

  it('is due after up, then daily, never while running', () => {
    expect(canaryDue(board, now())).toBe(true);
    const run = start();
    expect(canaryDue(board, now())).toBe(false);
    clock += 16 * MIN;
    advanceCanaryRun(board, run, now());
    expect(canaryDue(board, now())).toBe(false);
    markCanaryDue(board);
    expect(canaryDue(board, now())).toBe(true);
  });

  it('refuses a second run in flight', () => {
    start();
    expect(() => start()).toThrow(/already in flight/);
  });

  it('excludes canary ids from the board counts', () => {
    const run = start();
    play(run.taskId, { stamp: true });
    const c = peekQueue(board);
    expect(c).toEqual({ queued: 1 - 1, inflight: 0, done: 0, failed: 0 });
  });

  it('canary run: pass record exit 0, failure exit 1 with planner message, refuses under a hold', async () => {
    const logs: string[] = [];
    const sent: string[] = [];
    const deps = (stamp: boolean) => ({
      boardDir: board,
      workDir: root,
      baseSha: 'a'.repeat(40),
      dispatchedBy: 'canary',
      now,
      log: (l: string) => logs.push(l),
      notifyPlanner: (t: string) => sent.push(t),
      sleep: async () => {
        const r = runningCanary(board);
        if (!r) return;
        if (!r.stages.claimed) play(r.taskId, { stamp });
        else if (!r.stages.reclaimed && (!stamp ? false : true)) {
          play(r.followTaskId, { stamp: false, verdict: false });
        } else clock += 11 * MIN;
      },
    });
    expect(await runLoopCanaryCommand(deps(true))).toBe(0);
    clock += MIN;
    expect(await runLoopCanaryCommand(deps(false))).toBe(1);
    expect(sent[0]).toContain('executorCleared');
    writeHold(board, { reason: 'x', since: '', by: 'p' });
    expect(await runLoopCanaryCommand(deps(true))).toBe(1);
    expect(logs.at(-1)).toContain('held');
  });
});
