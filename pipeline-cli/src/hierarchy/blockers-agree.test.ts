/**
 * The blockers list and the eligible queue agree on which prerequisites are done (AISDLC-1341).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { ensureBoardDirs, listBoard, writeManifest, writeVerdict } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { computeBlockers } from './dispatch-loop.js';

let root: string;
let board: string;

function completedTask(id: string): void {
  const abs = path.join(root, 'backlog', 'completed', `${id.toLowerCase()} - t.md`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `---\nid: ${id}\ntitle: t\nstatus: Done\n---\n\nbody\n`);
}

function verdict(id: string, landed?: string): void {
  writeVerdict(board, {
    schemaVersion: 'v1',
    taskId: id,
    outcome: 'success',
    completedAt: '2026-05-20T10:30:00.000Z',
    workerId: 'w',
    ...(landed ? { landed } : {}),
  });
}

function queue(id: string, after: string[]): void {
  writeManifest(board, {
    schemaVersion: 'v1',
    taskId: id,
    branch: `ai-sdlc/${id.toLowerCase()}`,
    worktree: `.worktrees/${id.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
    after,
  } as DispatchManifest);
}

const eligible = (id: string): boolean =>
  listBoard(board).find((e) => e.state === 'queue' && e.taskId === id)?.eligible === true;
const waits = (): string[] =>
  computeBlockers(board, null, []).filter((l) => l.includes('waits on'));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'blockers-agree-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => removeFixtureDir(root));

describe('blockers agree with the eligible queue', () => {
  it('a prerequisite Done on main with no done/ record is not a blocker', () => {
    completedTask('AISDLC-1');
    queue('AISDLC-2', ['AISDLC-1']);
    expect(waits()).toEqual([]);
    expect(eligible('AISDLC-2')).toBe(true);
  });

  it('a success verdict that has not landed is a blocker', () => {
    verdict('AISDLC-1');
    queue('AISDLC-2', ['AISDLC-1']);
    expect(waits()).toEqual(['AISDLC-2: waits on AISDLC-1']);
    expect(eligible('AISDLC-2')).toBe(false);
  });

  it('a landed prerequisite is not a blocker', () => {
    verdict('AISDLC-1', '2026-05-20T11:00:00.000Z');
    queue('AISDLC-2', ['AISDLC-1']);
    expect(waits()).toEqual([]);
    expect(eligible('AISDLC-2')).toBe(true);
  });
});
