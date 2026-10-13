import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));

import { claimNext, ensureBoardDirs, writeManifest } from './board.js';
import { completeTask } from './complete.js';
import { requeueFailed } from './requeue.js';

let root: string;
let board: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'requeue-pr-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
  writeManifest(board, {
    schemaVersion: 'v1',
    taskId: 'AISDLC-930',
    branch: 'ai-sdlc/aisdlc-930',
    worktree: '.worktrees/aisdlc-930',
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    retryCount: 3,
    spec: { taskFile: 'backlog/tasks/aisdlc-930.md', verifyCommands: ['pnpm build'] },
  });
  claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
  completeTask(board, {
    taskId: 'AISDLC-930',
    outcome: 'failed',
    cause: 'transient',
    workerId: 'executor-a',
  });
  const f = path.join(board, 'failed', 'AISDLC-930.verdict.json');
  const v = JSON.parse(readFileSync(f, 'utf-8'));
  v.prUrl = 'https://github.com/o/r/pull/9';
  writeFileSync(f, JSON.stringify(v));
});
afterEach(() => {
  execFileSync.mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe('requeueFailed default PR state reader', () => {
  it('treats an OPEN gh answer as follow-up', () => {
    execFileSync.mockReturnValue('OPEN\n');
    const r = requeueFailed(board, 'AISDLC-930');
    expect(r.followUp).toBe(true);
    expect(execFileSync.mock.calls[0][1]).toContain('https://github.com/o/r/pull/9');
  });

  it('applies the cap when gh answers MERGED', () => {
    execFileSync.mockReturnValue('MERGED\n');
    expect(() => requeueFailed(board, 'AISDLC-930')).toThrow(/limit is/);
  });

  it('applies the cap when gh answers nothing', () => {
    execFileSync.mockReturnValue('\n');
    expect(() => requeueFailed(board, 'AISDLC-930')).toThrow(/limit is/);
  });

  it('applies the cap when gh fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('gh missing');
    });
    expect(() => requeueFailed(board, 'AISDLC-930')).toThrow(/limit is/);
  });
});
