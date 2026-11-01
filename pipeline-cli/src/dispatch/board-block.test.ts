/** `blockQueued` / `unblockManifest` round trip (AISDLC-1043). */

import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  blockQueued,
  ensureBoardDirs,
  listBoard,
  unblockManifest,
  writeManifest,
} from './board.js';
import type { DispatchManifest } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;

beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'board-block-'));
  ensureBoardDirs(board);
});

afterEach(() => {
  removeFixtureDir(board);
});

const at = (sub: string, id: string): string => path.join(board, sub, `${id}.dispatch.json`);

function queued(taskId: string): void {
  const m: DispatchManifest = {
    schemaVersion: 'v1',
    taskId,
    branch: 'b',
    worktree: 'w',
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: [] },
    after: ['T-0'],
    priority: 3,
  };
  writeManifest(board, m);
}

describe('blockQueued', () => {
  it('round-trips with after and priority intact', () => {
    queued('T-1');
    const now = () => new Date('2026-10-22T00:00:00.000Z');
    expect(blockQueued(board, 'T-1', 'waiting on table', 'planner', now)).toEqual({
      ok: true,
      alreadyBlocked: false,
    });
    expect(existsSync(at('queue', 'T-1'))).toBe(false);
    const parked = JSON.parse(readFileSync(at('blocked', 'T-1'), 'utf-8'));
    expect(parked.block).toEqual({
      blockedAt: '2026-10-22T00:00:00.000Z',
      blockedBy: 'planner',
      reason: 'waiting on table',
    });
    expect(listBoard(board).find((e) => e.state === 'blocked')?.reason).toBe('waiting on table');

    expect(unblockManifest(board, 'T-1')).toBe(true);
    const back = JSON.parse(readFileSync(at('queue', 'T-1'), 'utf-8'));
    expect(back.after).toEqual(['T-0']);
    expect(back.priority).toBe(3);
    expect(back.block).toBeUndefined();
  });

  it('is idempotent on a blocked task', () => {
    queued('T-1');
    blockQueued(board, 'T-1', 'r', 'p');
    expect(blockQueued(board, 'T-1', 'other', 'p')).toEqual({ ok: true, alreadyBlocked: true });
    expect(JSON.parse(readFileSync(at('blocked', 'T-1'), 'utf-8')).block.reason).toBe('r');
  });

  it('refuses an inflight task', () => {
    queued('T-1');
    renameSync(at('queue', 'T-1'), at('inflight', 'T-1'));
    const r = blockQueued(board, 'T-1', 'r', 'p');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('inflight') });
    expect(existsSync(at('inflight', 'T-1'))).toBe(true);
  });

  it('refuses a done task and an unknown task', () => {
    writeManifestVerdict();
    expect(blockQueued(board, 'T-9', 'r', 'p')).toEqual({
      ok: false,
      reason: expect.stringContaining('done'),
    });
    expect(blockQueued(board, 'T-404', 'r', 'p')).toEqual({
      ok: false,
      reason: expect.stringContaining('not on the board'),
    });
  });
});

function writeManifestVerdict(): void {
  writeFileSync(path.join(board, 'done', 'T-9.verdict.json'), '{}');
}
