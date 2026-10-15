import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decide, reconcile, type ReconcilePr } from './reconcile.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'ruling-reconcile-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

const now = () => new Date('2026-10-15T00:00:00.000Z');
const red = [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure' as const, summary: 'boom' }];
const pr = (over: Partial<ReconcilePr> = {}): ReconcilePr => ({
  prNumber: 10,
  taskId: 'AISDLC-1',
  title: 'feat: x (AISDLC-1)',
  headBranch: 'ai-sdlc/aisdlc-1-x',
  headSha: 'abc123',
  draft: false,
  mergeStateStatus: 'CLEAN',
  checks: red,
  ...over,
});
const queue = (id: string, ruling?: object) => {
  mkdirSync(path.join(board, 'queue'), { recursive: true });
  writeFileSync(
    path.join(board, 'queue', `${id}.dispatch.json`),
    JSON.stringify({ taskId: id, ...(ruling ? { ruling } : {}) }),
  );
};
const ruling = { text: 'hold for AISDLC-9', until: 'AISDLC-9', at: '2026-10-15T00:00:00.000Z' };

describe('planner rulings in the reconciler (AISDLC-903)', () => {
  it('reports a red PR whose task carries a ruling as held, with the text', () => {
    queue('AISDLC-1', ruling);
    const execute = vi.fn(() => ({ ran: true }));
    const report = reconcile([pr()], { boardDir: board, execute, now });
    expect(execute).not.toHaveBeenCalled();
    expect(report.records[0]).toMatchObject({ action: 'held', ruling: 'hold for AISDLC-9' });
    expect(report.acted[0]?.note).toContain('hold for AISDLC-9');
  });

  it('holds a no-match PR instead of routing it to the planner', () => {
    const noMatch = pr({ checks: [{ name: 'ci', conclusion: 'success' }] });
    expect(decide(noMatch).action).toBe('route-to-planner');
    expect(decide(noMatch, undefined, { ruling, untilMerged: false }).action).toBe('held');
  });

  it('clears the ruling and reports ready-to-requeue once the until task has landed', () => {
    queue('AISDLC-1', ruling);
    const report = reconcile([pr(), pr({ prNumber: 11, taskId: 'AISDLC-9', merged: true })], {
      boardDir: board,
      execute: vi.fn(() => ({ ran: true })),
      now,
    });
    expect(report.records.find((r) => r.pr === 10)?.action).toBe('ready-to-requeue');
    const raw = readFileSync(path.join(board, 'queue', 'AISDLC-1.dispatch.json'), 'utf-8');
    expect(JSON.parse(raw).ruling).toBeUndefined();
  });

  it('sees a landing recorded by an earlier pass and leaves unruled tasks alone', () => {
    queue('AISDLC-1', ruling);
    queue('AISDLC-2');
    const execute = vi.fn(() => ({ ran: true }));
    reconcile([pr({ prNumber: 11, taskId: 'AISDLC-9', merged: true })], {
      boardDir: board,
      execute,
      now,
    });
    const report = reconcile([pr(), pr({ prNumber: 12, taskId: 'AISDLC-2' })], {
      boardDir: board,
      execute,
      now,
    });
    expect(report.records.find((r) => r.pr === 10)?.action).toBe('ready-to-requeue');
    expect(report.records.find((r) => r.pr === 12)?.action).toBe('reenter');
  });
});
