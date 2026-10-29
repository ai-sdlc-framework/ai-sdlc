import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { LOOP_STATE_FILENAME } from './dispatch-loop.js';
import {
  formatLastTick,
  hostTickStale,
  hostWatchCheck,
  lastTickInfo,
  startHostWatch,
} from './host-liveness.js';
import { MAX_EVENT_FILES, pruneEvents } from './pr-snapshot.js';

const NOW = new Date('2026-10-28T12:00:00Z');

function board(lastTickAt?: string, by?: string, queued = 0): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
  mkdirSync(path.join(dir, 'queue'), { recursive: true });
  for (let i = 0; i < queued; i++) {
    writeFileSync(path.join(dir, 'queue', `AISDLC-${i + 1}.dispatch.json`), '{}');
  }
  writeFileSync(
    path.join(dir, LOOP_STATE_FILENAME),
    JSON.stringify({
      schemaVersion: 'v1',
      ingested: {},
      rejected: {},
      handled: [],
      ...(lastTickAt ? { lastTickAt } : {}),
      ...(by ? { lastTickBy: by } : {}),
    }),
  );
  return dir;
}

describe('host liveness', () => {
  it('is stale after three missed intervals or with no record', () => {
    expect(hostTickStale(board(), NOW)).toBe(true);
    expect(hostTickStale(board('2026-10-28T11:58:00Z'), NOW)).toBe(true);
    expect(hostTickStale(board('2026-10-28T11:59:00Z'), NOW)).toBe(false);
  });

  it('ticks as the scheduler when the host is silent and work is queued', () => {
    const runTick = vi.fn();
    const dir = board('2026-10-28T11:00:00Z', 'host', 1);
    expect(hostWatchCheck({ boardDir: dir, now: () => NOW, runTick })).toBe(true);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it('never ticks while the host is alive or with nothing queued', () => {
    const runTick = vi.fn();
    const alive = board('2026-10-28T11:59:50Z', 'host', 1);
    expect(hostWatchCheck({ boardDir: alive, now: () => NOW, runTick })).toBe(false);
    const idle = board('2026-10-28T11:00:00Z', 'host', 0);
    expect(hostWatchCheck({ boardDir: idle, now: () => NOW, runTick })).toBe(false);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('survives a throwing tick and stops on request', () => {
    vi.useFakeTimers();
    const runTick = vi.fn(() => {
      throw new Error('boom');
    });
    const dir = board(undefined, undefined, 1);
    const w = startHostWatch({ boardDir: dir, now: () => NOW, runTick, intervalMs: 10 });
    vi.advanceTimersByTime(25);
    w.stop();
    vi.advanceTimersByTime(100);
    expect(runTick).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reports the last tick age and author', () => {
    const t = lastTickInfo(board('2026-10-28T11:59:15Z', 'scheduler'), NOW);
    expect(t).toEqual({ ageSec: 45, by: 'scheduler' });
    expect(formatLastTick(t)).toBe('last tick: 45s ago by scheduler');
    expect(formatLastTick(undefined)).toBe('last tick: never');
    expect(lastTickInfo(board(), NOW)).toBeUndefined();
  });
});

describe('pruneEvents', () => {
  const name = (pr: number | 'none', i: number, kind = 'check_run'): string =>
    `${encodeURIComponent(`o/r#${pr}@abc1234:${kind}:d${i}`)}.json`;

  it('drops events for closed PRs and caps the rest, keeping canary records', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    const ev = path.join(dir, 'events');
    mkdirSync(ev);
    for (let i = 0; i < 5; i++) writeFileSync(path.join(ev, name(7, i)), '{}');
    for (let i = 0; i < 4; i++) writeFileSync(path.join(ev, name(8, i)), '{}');
    writeFileSync(path.join(ev, name('none', 1, 'pipeline-canary-red')), '{}');
    writeFileSync(path.join(ev, 'junk.txt'), '');
    expect(pruneEvents(dir, new Set([8]), 3)).toBe(5 + 1);
    const left = readdirSync(ev);
    expect(left.filter((f) => f.endsWith('.json'))).toHaveLength(4);
    expect(left.some((f) => f.includes('canary'))).toBe(true);
  });

  it('does not prune by PR when the open-PR set is empty', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    const ev = path.join(dir, 'events');
    mkdirSync(ev);
    for (let i = 0; i < 3; i++) writeFileSync(path.join(ev, name(7, i)), '{}');
    expect(pruneEvents(dir, new Set())).toBe(0);
    expect(readdirSync(ev)).toHaveLength(3);
  });

  it('caps without an open-PR list and exposes the default cap', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    const ev = path.join(dir, 'events');
    mkdirSync(ev);
    for (let i = 0; i < 4; i++) writeFileSync(path.join(ev, name(9, i)), '{}');
    expect(pruneEvents(dir, undefined, 2)).toBe(2);
    expect(pruneEvents(dir)).toBe(0);
    expect(MAX_EVENT_FILES).toBe(2000);
    expect(pruneEvents(path.join(dir, 'none'))).toBe(0);
  });
});
