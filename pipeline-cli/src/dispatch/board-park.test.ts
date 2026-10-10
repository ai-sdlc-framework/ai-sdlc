/** Parking an inflight manifest in blocked/ and returning it to queue/ (RFC-0051 escalation chain). */

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, parkInflight, unblockManifest, writeManifest } from './board.js';
import type { DispatchManifest } from './types.js';

let board: string;

beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'board-park-'));
  ensureBoardDirs(board);
});

afterEach(() => {
  rmSync(board, { recursive: true, force: true });
});

function inflight(taskId: string): void {
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
  };
  writeManifest(board, m);
  renameSync(
    path.join(board, 'queue', `${taskId}.dispatch.json`),
    path.join(board, 'inflight', `${taskId}.dispatch.json`),
  );
}

const at = (sub: string, id: string): string => path.join(board, sub, `${id}.dispatch.json`);

describe('parkInflight', () => {
  it('moves the manifest to blocked/ with blockedBy and drops the claim sidecars', () => {
    inflight('T-1');
    writeFileSync(path.join(board, 'inflight', 'T-1.state.json'), '{}');
    writeFileSync(path.join(board, 'inflight', 'T-1.resume.json'), '{}');
    expect(parkInflight(board, 'T-1', 'DEC-0007')).toBe(true);
    expect(existsSync(at('inflight', 'T-1'))).toBe(false);
    expect(existsSync(path.join(board, 'inflight', 'T-1.state.json'))).toBe(false);
    expect(existsSync(path.join(board, 'inflight', 'T-1.resume.json'))).toBe(false);
    expect(JSON.parse(readFileSync(at('blocked', 'T-1'), 'utf8')).blockedBy).toBe('DEC-0007');
  });

  it('returns false and changes nothing when nothing is inflight', () => {
    expect(parkInflight(board, 'T-2', 'DEC-0007')).toBe(false);
    expect(existsSync(at('blocked', 'T-2'))).toBe(false);
  });

  it('refuses to overwrite an existing parked manifest', () => {
    inflight('T-3');
    parkInflight(board, 'T-3', 'DEC-0001');
    inflight('T-3');
    expect(() => parkInflight(board, 'T-3', 'DEC-0002')).toThrow(/already exists/);
    expect(existsSync(at('inflight', 'T-3'))).toBe(true);
  });

  it('rejects a traversal task id', () => {
    expect(() => parkInflight(board, '../x', 'DEC-0001')).toThrow();
  });
});

describe('unblockManifest with an expected decision', () => {
  it('returns the manifest to queue/ only when it waits on that decision', () => {
    inflight('T-4');
    parkInflight(board, 'T-4', 'DEC-0004');
    expect(unblockManifest(board, 'T-4', 'DEC-0009')).toBe(false);
    expect(existsSync(at('blocked', 'T-4'))).toBe(true);
    expect(unblockManifest(board, 'T-4', 'DEC-0004')).toBe(true);
    expect(existsSync(at('queue', 'T-4'))).toBe(true);
    expect(JSON.parse(readFileSync(at('queue', 'T-4'), 'utf8')).blockedBy).toBeUndefined();
  });
});
