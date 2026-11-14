import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { hostWatchCheck } from './host-liveness.js';
import { LOOP_STATE_FILENAME } from './dispatch-loop.js';
import {
  checkRunningTick,
  clearTickRecord,
  readTickRecord,
  tickStallMs,
  writeTickRecord,
} from './tick-watchdog.js';
import { createSystemRunner } from './system-runner.js';
import { DEFAULT_TMUX_TIMEOUT_MS, tmuxTimeoutMs } from './tmux.js';

const NOW = new Date('2026-11-09T12:00:00Z');

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
  writeFileSync(path.join(dir, 'reconcile-scheduler.json'), JSON.stringify({ pid: 10 }));
  const alive = new Set<number>();
  const signals: [number, string][] = [];
  const pending: (() => void)[] = [];
  const watchdog = {
    isAlive: (p: number) => alive.has(p),
    kill: (p: number, s: 'SIGTERM' | 'SIGKILL') => {
      signals.push([p, s]);
      if (s === 'SIGKILL') alive.delete(p);
    },
    later: (fn: () => void) => pending.push(fn),
  };
  return { dir, alive, signals, pending, watchdog };
}

describe('tick watchdog (AISDLC-1255)', () => {
  it('kills a tick older than the stall limit, logs tick-stalled, keeps the scheduler pid', () => {
    const t = setup();
    t.alive.add(99);
    writeTickRecord(t.dir, { pid: 99, startedAt: NOW.getTime() - 300_000 });
    const r = checkRunningTick({
      boardDir: t.dir,
      now: () => NOW,
      stallMs: 120_000,
      ...t.watchdog,
    });
    expect(r).toBe('reaped');
    expect(t.signals).toEqual([[99, 'SIGTERM']]);
    t.pending.forEach((f) => f());
    expect(t.signals).toEqual([
      [99, 'SIGTERM'],
      [99, 'SIGKILL'],
    ]);
    const ev = JSON.parse(readFileSync(path.join(t.dir, 'board-events.jsonl'), 'utf-8'));
    expect(ev).toMatchObject({ event: 'tick-stalled', pid: 99, ageSec: 300 });
    expect(readTickRecord(t.dir)).toBeUndefined();
    expect(
      JSON.parse(readFileSync(path.join(t.dir, 'reconcile-scheduler.json'), 'utf-8')).pid,
    ).toBe(10);
  });

  it('leaves a live tick within its limit, and clears a dead one', () => {
    const t = setup();
    t.alive.add(99);
    writeTickRecord(t.dir, { pid: 99, startedAt: NOW.getTime() - 10_000 });
    const deps = { boardDir: t.dir, now: () => NOW, stallMs: 120_000, ...t.watchdog };
    expect(checkRunningTick(deps)).toBe('running');
    t.alive.clear();
    expect(checkRunningTick(deps)).toBe('idle');
    expect(readTickRecord(t.dir)).toBeUndefined();
    expect(checkRunningTick(deps)).toBe('idle');
    clearTickRecord(t.dir);
  });

  it('a SIGKILL follow-up is skipped when SIGTERM worked', () => {
    const t = setup();
    t.alive.add(99);
    writeTickRecord(t.dir, { pid: 99, startedAt: 0 });
    checkRunningTick({ boardDir: t.dir, now: () => NOW, stallMs: 1, ...t.watchdog });
    t.alive.delete(99);
    t.pending.forEach((f) => f());
    expect(t.signals).toEqual([[99, 'SIGTERM']]);
  });

  it('the scheduler reaps a stalled tick and, with work queued, starts the next', () => {
    const t = setup();
    writeFileSync(
      path.join(t.dir, LOOP_STATE_FILENAME),
      JSON.stringify({ schemaVersion: 'v1', ingested: {}, rejected: {}, handled: [] }),
    );
    t.alive.add(99);
    writeTickRecord(t.dir, { pid: 99, startedAt: NOW.getTime() - 300_000 });
    let started = 0;
    hostWatchCheck({
      boardDir: t.dir,
      now: () => NOW,
      stallMs: 120_000,
      watchdog: t.watchdog,
      runTick: () => {
        started++;
        return 123;
      },
    });
    expect(t.signals[0]).toEqual([99, 'SIGTERM']);
    // empty queue: no new tick, but the stalled one is gone
    expect(started).toBe(0);
    expect(readTickRecord(t.dir)).toBeUndefined();
  });

  it('a started tick is recorded and cleared on exit; a live one blocks the next', async () => {
    const t = setup();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(t.dir, 'queue'), { recursive: true });
    writeFileSync(path.join(t.dir, 'queue', 'AISDLC-1.dispatch.json'), '{}');
    writeFileSync(
      path.join(t.dir, LOOP_STATE_FILENAME),
      JSON.stringify({ schemaVersion: 'v1', ingested: {}, rejected: {}, handled: [] }),
    );
    let exit = (): void => {};
    let started = 0;
    const deps = {
      boardDir: t.dir,
      now: () => NOW,
      stallMs: 120_000,
      watchdog: t.watchdog,
      runTick: (onExit: () => void) => {
        started++;
        exit = onExit;
        t.alive.add(123);
        return 123;
      },
    };
    expect(hostWatchCheck(deps)).toBe(true);
    expect(readTickRecord(t.dir)).toEqual({ pid: 123, startedAt: NOW.getTime() });
    expect(hostWatchCheck(deps)).toBe(false);
    expect(started).toBe(1);
    exit();
    expect(readTickRecord(t.dir)).toBeUndefined();
  });

  it('stall limit defaults to twice the interval and honours the env override', () => {
    expect(tickStallMs(30_000, {})).toBe(60_000);
    expect(tickStallMs(30_000, { AI_SDLC_TICK_STALL_MINUTES: '5' })).toBe(300_000);
    expect(tickStallMs(30_000, { AI_SDLC_TICK_STALL_MINUTES: 'x' })).toBe(60_000);
  });
});

describe('tmux timeout (AISDLC-1255)', () => {
  it('defaults to 5 s and is env-overridable', () => {
    expect(tmuxTimeoutMs({})).toBe(DEFAULT_TMUX_TIMEOUT_MS);
    expect(tmuxTimeoutMs({ AI_SDLC_TMUX_TIMEOUT_MS: '250' })).toBe(250);
    expect(tmuxTimeoutMs({ AI_SDLC_TMUX_TIMEOUT_MS: '-1' })).toBe(5000);
  });

  it('the system runner kills a command past its timeout and reports timedOut', () => {
    const r = createSystemRunner()('sleep', ['5'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
  });
});
