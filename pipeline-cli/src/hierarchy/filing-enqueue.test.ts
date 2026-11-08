import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { writeManifest } from '../dispatch/board.js';
import { renderBriefBlock } from './brief-format.js';
import { autoEnqueueFiled, filedTaskIdFrom, readTaskOnMain } from './filing-enqueue.js';
import { reconcile, type ReconcilePr } from './reconcile.js';
import type { CommandRunner } from './types.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'filing-enqueue-'));
});
afterEach(() => removeFixtureDir(board));

const taskFile = (extra = ''): string =>
  `---\nid: AISDLC-9\ntitle: x\nstatus: To Do\npriority: high\n${extra}---\n\nbody\n`;

function writeBrief(id = 'aisdlc-9'): void {
  mkdirSync(path.join(board, 'briefs'), { recursive: true });
  writeFileSync(
    path.join(board, 'briefs', `tasks-${id}.md`),
    `# brief\n\n${renderBriefBlock([{ task: id.toUpperCase(), after: [], wave: 2, priority: 1 }])}\n`,
  );
}

describe('autoEnqueueFiled (AISDLC-1242)', () => {
  const mk = (...args: [string | undefined] | []) => {
    const enqueue = vi.fn();
    const raw = args.length === 0 ? taskFile() : args[0];
    return { enqueue, deps: { readTaskOnMain: () => raw, enqueue } };
  };

  it('enqueues from the brief with its wave and priority and returns one line', () => {
    writeBrief();
    const { enqueue, deps } = mk();
    const line = autoEnqueueFiled(board, 77, 'ai-sdlc/file-aisdlc-9', deps);
    expect(line).toBe('auto-enqueued AISDLC-9 from tasks-aisdlc-9.md (filing #77 landed)');
    expect(enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: 'AISDLC-9', wave: 2, priority: 1 }),
    ]);
  });

  it.each([
    ['dispatchable: false', 'ai-sdlc/file-aisdlc-9', taskFile('dispatchable: false\n')],
    ['blocked.reason', 'ai-sdlc/file-aisdlc-9', taskFile('blocked:\n  reason: waiting\n')],
    ['an --update branch', 'ai-sdlc/update-aisdlc-9', taskFile()],
    ['a missing task file', 'ai-sdlc/file-aisdlc-9', undefined],
  ])('leaves the task alone for %s', (_n, branch, raw) => {
    writeBrief();
    const { enqueue, deps } = mk(raw);
    expect(autoEnqueueFiled(board, 1, branch, deps)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves a task already on the board alone', () => {
    writeBrief();
    writeManifest(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      branch: 'b',
      worktree: '.worktrees/aisdlc-9',
      baseSha: 'abc',
      workerKind: 'any',
      dispatchedAt: '2026-01-01T00:00:00Z',
      dispatchedBy: 't',
      spec: { taskFile: 'x.md', verifyCommands: [] },
    });
    const { enqueue, deps } = mk();
    expect(autoEnqueueFiled(board, 1, 'ai-sdlc/file-aisdlc-9', deps)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing without a brief, and survives an enqueue refusal', () => {
    const a = mk();
    expect(autoEnqueueFiled(board, 1, 'ai-sdlc/file-aisdlc-9', a.deps)).toBeUndefined();
    writeBrief();
    const enqueue = vi.fn(() => {
      throw new Error('refused');
    });
    expect(
      autoEnqueueFiled(board, 1, 'ai-sdlc/file-aisdlc-9', {
        readTaskOnMain: () => taskFile(),
        enqueue,
      }),
    ).toBeUndefined();
  });

  it('filedTaskIdFrom rejects non-task slugs', () => {
    expect(filedTaskIdFrom('ai-sdlc/file-notes')).toBeUndefined();
    expect(filedTaskIdFrom(undefined)).toBeUndefined();
    expect(filedTaskIdFrom('ai-sdlc/file-aisdlc-521.1')).toBe('AISDLC-521.1');
  });
});

describe('readTaskOnMain', () => {
  it('reads the task file from origin/main', () => {
    const run: CommandRunner = (_f, args) =>
      args[0] === 'ls-tree'
        ? { status: 0, stdout: 'backlog/tasks/AISDLC-9 - x.md\n', stderr: '' }
        : { status: 0, stdout: 'RAW', stderr: '' };
    expect(readTaskOnMain(run, '/', 'AISDLC-9')).toBe('RAW');
    expect(readTaskOnMain(run, '/', 'AISDLC-8')).toBeUndefined();
    const bad: CommandRunner = () => ({ status: 1, stdout: '', stderr: '' });
    expect(readTaskOnMain(bad, '/', 'AISDLC-9')).toBeUndefined();
  });
});

describe('reconcile auto-enqueue (AISDLC-1242)', () => {
  const filing = (over: Partial<ReconcilePr> = {}): ReconcilePr => ({
    prNumber: 77,
    taskId: '',
    title: 'chore(docs): file AISDLC-9',
    headBranch: 'ai-sdlc/file-aisdlc-9',
    headSha: 'def456',
    merged: true,
    draft: false,
    mergeStateStatus: 'CLEAN',
    checks: [],
    ...over,
  });
  const opts = (enqueueFiled: () => string | undefined, notifyPlanner = vi.fn()) => ({
    boardDir: board,
    execute: () => ({ ran: false }),
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    enqueueFiled,
    notifyPlanner,
  });

  it('sends exactly one line per auto-enqueue, once across passes', () => {
    const notify = vi.fn();
    const enq = vi.fn(() => 'auto-enqueued AISDLC-9 from tasks-aisdlc-9.md (filing #77 landed)');
    reconcile([filing()], opts(enq, notify));
    reconcile([filing()], opts(enq, notify));
    expect(enq).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'auto-enqueued AISDLC-9 from tasks-aisdlc-9.md (filing #77 landed)',
    );
  });

  it('sends no line when the enqueue left the task alone or the notifier throws', () => {
    const notify = vi.fn();
    reconcile(
      [filing()],
      opts(() => undefined, notify),
    );
    expect(notify).not.toHaveBeenCalled();
    const boom = vi.fn(() => {
      throw new Error('no planner');
    });
    const report = reconcile(
      [filing({ prNumber: 78 })],
      opts(() => 'line', boom),
    );
    expect(report.acted.some((a) => a.action === 'auto-enqueue')).toBe(true);
  });
});
