/** AISDLC-1027: `after` is derived from the task file's `dependencies:`; a dependency counts once landed. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDependencyGraph, preflight } from '../deps/dependency-graph.js';
import {
  claimNext,
  ensureBoardDirs,
  listBoard,
  patchDoneVerdict,
  readQueuedManifest,
  writeManifest,
  writeVerdict,
} from './board.js';
import { enqueueTasks } from './enqueue.js';
import { reprioritizeQueued } from './reprioritize.js';
import { FAILED_MANIFEST_SUFFIX, requeueFailed } from './requeue.js';
import type { DispatchManifest } from './types.js';

let root: string;
let board: string;

function task(id: string, deps: string[], dir: 'tasks' | 'completed' = 'tasks'): string {
  const rel = `backlog/${dir}/${id.toLowerCase()} - t.md`;
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const status = dir === 'completed' ? 'Done' : 'To Do';
  writeFileSync(
    abs,
    `---\nid: ${id}\ntitle: t\nstatus: ${status}\ndependencies: [${deps.join(', ')}]\n---\n\nbody\n`,
  );
  return rel;
}

function mk(taskId: string, taskFile: string, extra: Partial<DispatchManifest> = {}) {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile, verifyCommands: ['pnpm build'] },
    ...extra,
  } as DispatchManifest;
}

function deliver(id: string, landed?: string): void {
  writeVerdict(board, {
    schemaVersion: 'v1',
    taskId: id,
    outcome: 'success',
    completedAt: '2026-05-20T10:30:00.000Z',
    workerId: 'w',
    ...(landed ? { landed } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'after-derive-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('after derived from dependencies', () => {
  it('enqueue fills after from the task file when none is passed', () => {
    const file = task('AISDLC-2', ['AISDLC-1', 'AISDLC-9']);
    enqueueTasks(board, [{ taskId: 'AISDLC-2' }], {
      baseSha: 'abc1234',
      dispatchedBy: 'op',
      workDir: root,
      resolveTaskFile: () => file,
    });
    expect(readQueuedManifest(board, 'AISDLC-2')?.after).toEqual(['AISDLC-1', 'AISDLC-9']);
  });

  it('enqueue keeps an explicit after', () => {
    const file = task('AISDLC-2', ['AISDLC-1']);
    enqueueTasks(board, [{ taskId: 'AISDLC-2', after: ['AISDLC-5'] }], {
      baseSha: 'abc1234',
      dispatchedBy: 'op',
      workDir: root,
      resolveTaskFile: () => file,
    });
    expect(readQueuedManifest(board, 'AISDLC-2')?.after).toEqual(['AISDLC-5']);
  });

  it('requeue fills after from the task file', () => {
    const file = task('AISDLC-2', ['AISDLC-1']);
    writeFileSync(
      path.join(board, 'failed', `AISDLC-2${FAILED_MANIFEST_SUFFIX}`),
      JSON.stringify(mk('AISDLC-2', file)),
    );
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-2.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-2', outcome: 'failed' }),
    );
    requeueFailed(board, 'AISDLC-2', { prState: () => 'NONE' });
    expect(readQueuedManifest(board, 'AISDLC-2')?.after).toEqual(['AISDLC-1']);
  });

  it('reprioritize fills after from the task file', () => {
    const file = task('AISDLC-2', ['AISDLC-1']);
    writeManifest(board, mk('AISDLC-2', file));
    reprioritizeQueued(board, 'AISDLC-2', { priority: 3 });
    const m = readQueuedManifest(board, 'AISDLC-2');
    expect(m?.after).toEqual(['AISDLC-1']);
    expect(m?.priority).toBe(3);
  });

  it('derives nothing when the repo root is unknown or the file is unreadable', () => {
    writeManifest(board, mk('AISDLC-2', 'backlog/tasks/missing.md'));
    reprioritizeQueued(board, 'AISDLC-2', { priority: 1 });
    expect(readQueuedManifest(board, 'AISDLC-2')?.after).toBeUndefined();
  });
});

describe('a dependency counts only once landed', () => {
  it('holds a delivered-not-landed dependency and releases it on landing', () => {
    const file = task('AISDLC-2', ['AISDLC-1']);
    task('AISDLC-1', []);
    writeManifest(board, mk('AISDLC-2', file, { after: ['AISDLC-1'] }));
    deliver('AISDLC-1');
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);
    expect(listBoard(board)[0]?.reason).toBe('waiting for AISDLC-1 to land');
    patchDoneVerdict(board, 'AISDLC-1', { landed: '2026-05-20T11:00:00.000Z' });
    expect(claimNext(board, 'in-session-agent').claimed).toBe(true);
  });

  it('releases a dependency whose task file is Done on main', () => {
    const file = task('AISDLC-2', ['AISDLC-1']);
    task('AISDLC-1', [], 'completed');
    writeManifest(board, mk('AISDLC-2', file, { after: ['AISDLC-1'] }));
    expect(claimNext(board, 'in-session-agent').claimed).toBe(true);
  });

  it('invariant: every eligible manifest passes the executor dependency preflight', () => {
    task('AISDLC-1', []);
    task('AISDLC-3', [], 'completed');
    const cases: [string, string[]][] = [
      ['AISDLC-10', ['AISDLC-1']],
      ['AISDLC-11', ['AISDLC-3']],
      ['AISDLC-12', []],
    ];
    for (const [id, deps] of cases) {
      const file = task(id, deps);
      enqueueTasks(board, [{ taskId: id }], {
        baseSha: 'abc1234',
        dispatchedBy: 'op',
        workDir: root,
        resolveTaskFile: () => file,
      });
    }
    deliver('AISDLC-1');
    const check = (): void => {
      const graph = buildDependencyGraph({ workDir: root });
      for (const e of listBoard(board).filter((x) => x.state === 'queue' && x.eligible)) {
        expect(preflight(graph, e.taskId).ok).toBe(true);
      }
    };
    check();
    expect(listBoard(board).find((e) => e.taskId === 'AISDLC-10')?.eligible).toBe(false);
    expect(listBoard(board).find((e) => e.taskId === 'AISDLC-11')?.eligible).toBe(true);
  });
});
