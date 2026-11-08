import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyHold, isDispatchableFalse, listHeld, triageHeld } from './held-triage.js';
import { formatStatus, type StatusResult } from './status.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let root: string;
let board: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'held-triage-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  mkdirSync(path.join(board, 'queue'), { recursive: true });
  mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
});
afterEach(() => removeFixtureDir(root));

const task = (id: string, fm: string, body = 'body') =>
  writeFileSync(
    path.join(root, 'backlog', 'tasks', `${id.toLowerCase()} - t.md`),
    `---\nid: ${id}\n${fm}\n---\n\n${body}\n`,
  );
const queue = (id: string, after: string[]) =>
  writeFileSync(
    path.join(board, 'queue', `${id}.dispatch.json`),
    JSON.stringify({ taskId: id, after }),
  );
const now = new Date('2026-11-08T00:00:00Z');

describe('classifyHold', () => {
  it('classifies the four cases', () => {
    expect(classifyHold({ heldId: 'A-1', onBoard: true })).toBe('waiting');
    expect(classifyHold({ heldId: 'A-1', onBoard: false })).toBe('absent');
    expect(
      classifyHold({ heldId: 'A-1', onBoard: false, dependencyText: '---\nid: A-2\n---\nx' }),
    ).toBe('absent');
    expect(
      classifyHold({
        heldId: 'A-1',
        onBoard: false,
        dependencyText: '---\ndispatchable: false\n---\nx',
      }),
    ).toBe('operator-gated');
    expect(
      classifyHold({
        heldId: 'A-1',
        onBoard: false,
        dependencyText: '---\ndispatchable: false\n---\n- [ ] closes after a-1 lands',
      }),
    ).toBe('circular');
    expect(isDispatchableFalse('---\ndispatchable: true\n---')).toBe(false);
  });
});

describe('listHeld fixtures', () => {
  it('506/496 is operator-gated, 1179.1/1179 is circular, a queued dependency waits', () => {
    task('AISDLC-496', 'dispatchable: false', 'operator reason');
    queue('AISDLC-506', ['AISDLC-496']);
    task('AISDLC-1179', 'dispatchable: false', 'remaining: AISDLC-1179.1');
    queue('AISDLC-1179.1', ['AISDLC-1179']);
    queue('AISDLC-7', ['AISDLC-8']);
    queue('AISDLC-8', []);
    queue('AISDLC-9', ['AISDLC-404']);
    const by = Object.fromEntries(listHeld(board, root).map((r) => [r.taskId, r]));
    expect(by['AISDLC-506']?.class).toBe('operator-gated');
    expect(by['AISDLC-506']?.dependencyPath).toContain('aisdlc-496');
    expect(by['AISDLC-1179.1']?.class).toBe('circular');
    expect(by['AISDLC-7']?.class).toBe('waiting');
    expect(by['AISDLC-9']?.class).toBe('absent');
  });

  it('returns nothing without a queue', () => {
    removeFixtureDir(path.join(board, 'queue'));
    expect(listHeld(board, root)).toEqual([]);
  });
});

describe('triageHeld', () => {
  it('writes one record and one planner line, then nothing while the class is unchanged', () => {
    task('AISDLC-496', 'dispatchable: false');
    queue('AISDLC-506', ['AISDLC-496']);
    queue('AISDLC-7', ['AISDLC-8']);
    queue('AISDLC-8', []);
    const notify = vi.fn();
    expect(triageHeld(board, root, now, notify)).toEqual(['AISDLC-506']);
    expect(triageHeld(board, root, now, notify)).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain('operator-gated');
    const rec = JSON.parse(
      readFileSync(path.join(board, 'held', 'AISDLC-506--AISDLC-496.json'), 'utf-8'),
    );
    expect(rec).toMatchObject({
      class: 'operator-gated',
      dependency: 'AISDLC-496',
      notified: true,
    });
    expect(existsSync(path.join(board, 'held', 'AISDLC-7--AISDLC-8.json'))).toBe(false);
  });

  it('announces again when the class changes, and retries after a failed send', () => {
    queue('AISDLC-506', ['AISDLC-496']);
    const failing = vi.fn(() => {
      throw new Error('no planner');
    });
    expect(triageHeld(board, root, now, failing)).toEqual([]);
    const ok = vi.fn();
    expect(triageHeld(board, root, now, ok)).toEqual(['AISDLC-506']);
    task('AISDLC-496', 'dispatchable: false');
    expect(triageHeld(board, root, now, ok)).toEqual(['AISDLC-506']);
    expect(ok).toHaveBeenCalledTimes(2);
    writeFileSync(path.join(board, 'held', 'AISDLC-506--AISDLC-496.json'), 'not json');
    expect(triageHeld(board, root, now, ok)).toEqual(['AISDLC-506']);
  });
});

describe('triageHeld with two held dependencies', () => {
  it('records and announces each dependency once', () => {
    task('AISDLC-496', 'dispatchable: false');
    queue('AISDLC-10', ['AISDLC-496', 'AISDLC-404']);
    const notify = vi.fn();
    triageHeld(board, root, now, notify);
    triageHeld(board, root, now, notify);
    expect(notify).toHaveBeenCalledTimes(2);
    const a = JSON.parse(
      readFileSync(path.join(board, 'held', 'AISDLC-10--AISDLC-496.json'), 'utf-8'),
    );
    const b = JSON.parse(
      readFileSync(path.join(board, 'held', 'AISDLC-10--AISDLC-404.json'), 'utf-8'),
    );
    expect(a.class).toBe('operator-gated');
    expect(b.class).toBe('absent');
  });
});

describe('formatStatus held line', () => {
  it('prints the class next to the held line', () => {
    const lines = formatStatus({
      rows: [],
      webhook: { state: 'up' },
      scheduler: { state: 'off' },
      held: [{ taskId: 'AISDLC-506', dependency: 'AISDLC-496', class: 'absent' }],
    } as unknown as StatusResult);
    expect(lines).toContain('held: AISDLC-506 (waits on AISDLC-496) [absent]');
  });
});
