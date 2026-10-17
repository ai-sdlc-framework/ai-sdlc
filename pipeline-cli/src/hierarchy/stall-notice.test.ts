import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from '../dispatch/board.js';
import { runStallNotice } from './stall-notice.js';
import type { CommandRunner } from './types.js';

const T0 = Date.parse('2026-10-16T10:00:00Z');
let dir: string;
let calls: string[][];
let run: CommandRunner;
let nowMs: number;
const now = () => new Date(nowMs);
const check = (minutes?: number) =>
  runStallNotice({ boardDir: dir, now, run, platform: 'darwin', ...(minutes ? { minutes } : {}) });

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
  dir = mkdtempSync(path.join(os.tmpdir(), 'stall-notice-'));
  ensureBoardDirs(dir);
  calls = [];
  nowMs = T0;
  run = (file, args) => {
    calls.push([file, ...args]);
    if (file !== 'osascript') throw new Error(`unexpected process: ${file}`);
    return { status: 0, stdout: '', stderr: '' };
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runStallNotice (AISDLC-871)', () => {
  it('sends nothing for an empty queue', () => {
    nowMs = T0 + 600 * 60000;
    expect(check()).toMatchObject({ action: 'none', reason: 'empty-queue' });
    expect(calls).toEqual([]);
  });

  it('notifies once per stall, with one digest line, then stays quiet', () => {
    queue('AISDLC-1');
    check();
    nowMs = T0 + 46 * 60000;
    const r = check();
    expect(r).toMatchObject({ action: 'notified', idleMinutes: 46 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('osascript');
    expect(
      readFileSync(path.join(dir, 'stall-digest.log'), 'utf-8').trim().split('\n'),
    ).toHaveLength(1);
    nowMs += 60000;
    expect(check()).toMatchObject({ action: 'none', reason: 'already-notified' });
    expect(calls).toHaveLength(1);
  });

  it('sends nothing while a heartbeat moves; reports again after it stalls anew', () => {
    queue('AISDLC-1');
    queue('AISDLC-2');
    const beat = (at: number) =>
      writeHeartbeat(dir, {
        taskId: 'AISDLC-9',
        workerId: 'w',
        workerKind: 'any',
        startedAt: new Date(T0).toISOString(),
        lastHeartbeat: new Date(at).toISOString(),
      } as never);
    writeManifest(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      taskFile: 'x',
      branch: 'b',
      baseSha: 'a'.repeat(40),
      dispatchedAt: new Date(T0).toISOString(),
      dispatchedBy: 't',
    } as never);
    beat(T0);
    nowMs = T0 + 50 * 60000;
    beat(nowMs - 60000);
    expect(check()).toMatchObject({ action: 'none', reason: 'progress' });
    expect(calls).toEqual([]);
    nowMs += 46 * 60000;
    expect(check().action).toBe('notified');
  });

  it('honours --minutes', () => {
    queue('AISDLC-1');
    check();
    nowMs = T0 + 11 * 60000;
    expect(check(10).action).toBe('notified');
    expect(calls).toHaveLength(1);
  });

  it('uses notify-send off macOS and runs nothing but the notifier', () => {
    queue('AISDLC-1');
    const seen: string[] = [];
    const r = (file: string) => {
      seen.push(file);
      return { status: 0, stdout: '', stderr: '' };
    };
    runStallNotice({ boardDir: dir, now, run: r, platform: 'linux' });
    nowMs = T0 + 60 * 60000;
    runStallNotice({ boardDir: dir, now, run: r, platform: 'linux' });
    expect(seen).toEqual(['notify-send']);
  });
});
