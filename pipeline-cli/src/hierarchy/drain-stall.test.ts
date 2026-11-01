import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeManifest } from '../dispatch/board.js';
import {
  checkDrainStall,
  DEFAULT_DRAIN_STALL_MINUTES,
  formatDrainStall,
  readOpenDrainStall,
  resolveStallAfterMinutes,
} from './drain-stall.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const T0 = Date.parse('2026-10-28T09:00:00Z');
let dir: string;
let nowMs: number;
let idle: string[];

const check = (held: { reason: string; since: string; by: string } | null = null) =>
  checkDrainStall({ boardDir: dir, now: () => new Date(nowMs), held, idleExecutors: () => idle });

function queue(taskId: string): void {
  writeManifest(dir, {
    schemaVersion: 'v1',
    taskId,
    taskFile: `backlog/tasks/${taskId}.md`,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    baseSha: 'a'.repeat(40),
    dispatchedAt: new Date(T0).toISOString(),
    dispatchedBy: 'test',
  } as never);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'drain-stall-'));
  ensureBoardDirs(dir);
  nowMs = T0;
  idle = ['executor-1'];
});
afterEach(() => removeFixtureDir(dir));

describe('checkDrainStall (AISDLC-1101)', () => {
  it('opens one record after the threshold and names the stage', () => {
    queue('AISDLC-1');
    expect(check()).toEqual({});
    nowMs += (DEFAULT_DRAIN_STALL_MINUTES + 1) * 60_000;
    const r = check();
    expect(r.opened).toMatchObject({ stage: 'wake', eligible: 1, idleExecutors: ['executor-1'] });
    expect(formatDrainStall(r.opened!, 30)).toContain('Stalled stage: wake');
    expect(readOpenDrainStall(dir)).toEqual(r.opened);
    nowMs += 60_000;
    const again = check();
    expect(again.opened).toBeUndefined();
    expect(again.open).toBeDefined();
    const events = readFileSync(path.join(dir, 'drain-stalls.jsonl'), 'utf-8').trim().split('\n');
    expect(events).toHaveLength(1);
  });

  it('counts spawn errors with zero live executors as a stall (AISDLC-1117)', () => {
    idle = [];
    queue('AISDLC-1');
    const spawn = (liveExecutors: number) =>
      checkDrainStall({
        boardDir: dir,
        now: () => new Date(nowMs),
        held: null,
        idleExecutors: () => idle,
        spawnErrors: 1,
        liveExecutors,
      });
    expect(spawn(1)).toEqual({});
    spawn(0);
    nowMs += 31 * 60_000;
    const r = spawn(0);
    expect(r.opened).toMatchObject({ eligible: 1, idleExecutors: [] });
    expect(formatDrainStall(r.opened!, 30)).toContain('spawn errors with no live executor');
  });

  it('closes the record when the board moves', () => {
    queue('AISDLC-1');
    check();
    nowMs += 31 * 60_000;
    check();
    queue('AISDLC-2');
    const r = check();
    expect(r.closed).toBeDefined();
    expect(readOpenDrainStall(dir)).toBeUndefined();
  });

  it('records nothing while held or with no idle executor or no eligible work', () => {
    expect(check()).toEqual({});
    queue('AISDLC-1');
    check();
    nowMs += 60 * 60_000;
    expect(check({ reason: 'x', since: '', by: 'op' })).toEqual({});
    idle = [];
    expect(check()).toEqual({});
    idle = ['executor-1'];
    // the clock restarted when the condition lapsed
    expect(check()).toEqual({});
    nowMs += 31 * 60_000;
    expect(check().opened).toBeDefined();
  });

  it('honours stallAfterMinutes from config.json', () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ stallAfterMinutes: 5 }));
    expect(resolveStallAfterMinutes(dir)).toBe(5);
    queue('AISDLC-1');
    check();
    nowMs += 6 * 60_000;
    expect(check().opened).toBeDefined();
  });

  it('falls back to the default for a bad config', () => {
    writeFileSync(path.join(dir, 'config.json'), '{nope');
    expect(resolveStallAfterMinutes(dir)).toBe(DEFAULT_DRAIN_STALL_MINUTES);
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ stallAfterMinutes: -1 }));
    expect(resolveStallAfterMinutes(dir)).toBe(DEFAULT_DRAIN_STALL_MINUTES);
  });
});
