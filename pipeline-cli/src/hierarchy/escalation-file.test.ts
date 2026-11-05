import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyEscalation, writeEscalationFile } from './escalation-file.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'escalation-'));
  mkdirSync(path.join(board, 'failed'), { recursive: true });
});
afterEach(() => removeFixtureDir(board));

const now = new Date('2026-10-23T01:02:03Z');
const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

describe('writeEscalationFile', () => {
  it('records the failure record, the log tail and the PR check summary', () => {
    const notes = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-9.diagnostic.json'),
      JSON.stringify({ taskId: 'AISDLC-9', outcome: 'failed', notes, prNumber: 77 }),
    );
    const calls: string[][] = [];
    const { file } = writeEscalationFile({
      boardDir: board,
      taskId: 'AISDLC-9',
      message: 'unknown shape',
      now,
      run: (f, args) => {
        calls.push([f, ...args]);
        return ok('build\tpass\nlint\tfail\n');
      },
    });
    const body = JSON.parse(readFileSync(file, 'utf-8'));
    expect(body.failureRecord.outcome).toBe('failed');
    expect(body.logTail).toHaveLength(20);
    expect(body.logTail.at(-1)).toBe('line 30');
    expect(body.prCheckSummary).toEqual(['build\tpass', 'lint\tfail']);
    expect(body.message).toBe('unknown shape');
    expect(calls).toEqual([['gh', 'pr', 'checks', '77']]);
  });

  it('writes empty sections when the board holds no record, and refuses a bad id', () => {
    const { file } = writeEscalationFile({
      boardDir: board,
      taskId: 'AISDLC-10',
      message: 'm',
      now,
      run: () => ok(''),
    });
    const body = JSON.parse(readFileSync(file, 'utf-8'));
    expect(body).toMatchObject({ failureRecord: null, logTail: [], prCheckSummary: [] });
    expect(() =>
      writeEscalationFile({
        boardDir: board,
        taskId: '../x',
        message: 'm',
        now,
        run: () => ok(''),
      }),
    ).toThrow(/not a valid task id/);
  });

  it('falls back to a verdict file and tolerates an unreadable record', () => {
    writeFileSync(path.join(board, 'failed', 'AISDLC-11.diagnostic.json'), '{broken');
    mkdirSync(path.join(board, 'done'), { recursive: true });
    writeFileSync(
      path.join(board, 'done', 'AISDLC-11.verdict.json'),
      JSON.stringify({ outcome: 'success' }),
    );
    const { file } = writeEscalationFile({
      boardDir: board,
      taskId: 'AISDLC-11',
      message: 'm',
      now,
      run: () => ok(''),
    });
    expect(JSON.parse(readFileSync(file, 'utf-8')).failureRecord).toEqual({ outcome: 'success' });
  });
});

describe('notifyEscalation (AISDLC-1190)', () => {
  it('sends one line, not a repeat within the hour, and again after it', () => {
    mkdirSync(path.join(board, 'escalations'), { recursive: true });
    const notify = vi.fn();
    const go = (at: Date, msg = 'stuck') =>
      notifyEscalation(board, 'TICK-1', msg, 'f.json', at, notify);
    expect(go(now)).toBe(true);
    expect(go(new Date(now.getTime() + 60_000))).toBe(false);
    expect(go(new Date(now.getTime() + 60_000), 'other')).toBe(true);
    expect(go(new Date(now.getTime() + 61 * 60_000))).toBe(true);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[0]![0]).toContain('TICK-1');
  });

  it('does not record a failed send', () => {
    mkdirSync(path.join(board, 'escalations'), { recursive: true });
    const bad = vi.fn(() => {
      throw new Error('no planner');
    });
    expect(notifyEscalation(board, 'T', 'm', 'f', now, bad)).toBe(false);
    const good = vi.fn();
    expect(notifyEscalation(board, 'T', 'm', 'f', now, good)).toBe(true);
  });
});
