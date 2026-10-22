import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventFileName, type EventRecord } from '../dispatch/webhook-receiver.js';
import {
  CANARY_HOLD_PREFIX,
  CANARY_STATE_FILENAME,
  hotfixTaskId,
  hotfixTaskMarkdown,
  processCanaryEvents,
} from './canary.js';
import { readHold, writeHold } from './hold.js';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
let board: string;
let filed: { sha: string; detail: string }[];

beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'canary-'));
  filed = [];
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

function event(
  kind: 'pipeline-canary-red' | 'pipeline-canary-green',
  id: string,
  at: string,
  detail?: string,
): void {
  const rec: EventRecord = {
    repo: 'o/r',
    pr: null,
    headSha: SHA,
    kind,
    deliveryId: id,
    receivedAt: at,
    ...(detail === undefined ? {} : { detail }),
  };
  const dir = path.join(board, 'events');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, eventFileName(rec)), JSON.stringify(rec) + '\n');
}

function clearBoardHold(): void {
  rmSync(path.join(board, '.hold'), { force: true });
}

const run = (fail = false) =>
  processCanaryEvents({
    boardDir: board,
    now: () => new Date('2026-10-22T12:00:00.000Z'),
    fileHotfix: (o) => {
      if (fail) throw new Error('cli-file refused');
      filed.push(o);
      return hotfixTaskId(o.sha);
    },
  });

describe('processCanaryEvents (AISDLC-1023)', () => {
  it('a red canary holds the board with the sha and files one hotfix', () => {
    event('pipeline-canary-red', 'r1', '2026-10-22T10:00:00Z', 'step-10.5 ledger-not-staged');
    const r = run();
    expect(r.held).toBe(`pipeline canary red at ${SHA}`);
    expect(readHold(board)?.reason).toBe(`pipeline canary red at ${SHA}`);
    expect(filed).toEqual([{ sha: SHA, detail: 'step-10.5 ledger-not-staged' }]);
    expect(r.filed?.task).toBe(hotfixTaskId(SHA));
    // A second tick over the same delivery does nothing.
    expect(run()).toEqual({ errors: [] });
    expect(filed).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(board, CANARY_STATE_FILENAME), 'utf-8'))).toEqual({
      processed: ['r1'],
      highWater: '2026-10-22T10:00:00Z',
    });
  });

  it('never replays an old event once its delivery id has aged out of the state', () => {
    event('pipeline-canary-red', 'old', '2026-10-22T09:00:00Z');
    run();
    expect(filed).toHaveLength(1);
    // 250 later deliveries push 'old' out of the bounded id list.
    const statePath = path.join(board, CANARY_STATE_FILENAME);
    const ids = Array.from({ length: 250 }, (_, i) => `d${i}`);
    writeFileSync(statePath, JSON.stringify({ processed: ids, highWater: '2026-10-22T11:00:00Z' }));
    clearBoardHold();
    expect(run()).toEqual({ errors: [] });
    expect(filed).toHaveLength(1);
    expect(readHold(board)).toBeNull();
  });

  it('a green canary after a red one lifts the hold', () => {
    event('pipeline-canary-red', 'r1', '2026-10-22T10:00:00Z');
    event('pipeline-canary-green', 'g1', '2026-10-22T11:00:00Z');
    const r = run();
    expect(r.lifted).toBe(`pipeline canary red at ${SHA}`);
    expect(r.held).toBeUndefined();
    expect(readHold(board)).toBeNull();
  });

  it('a green canary never lifts a hold that is not the canary', () => {
    writeHold(board, { reason: 'operator pause', since: 'x', by: 'op' });
    event('pipeline-canary-green', 'g1', '2026-10-22T11:00:00Z');
    expect(run().lifted).toBeUndefined();
    expect(readHold(board)?.reason).toBe('operator pause');
  });

  it('a red then a later red keeps the hold and files a hotfix for each', () => {
    event('pipeline-canary-red', 'r1', '2026-10-22T10:00:00Z');
    event('pipeline-canary-red', 'r2', '2026-10-22T10:30:00Z');
    run();
    expect(filed).toHaveLength(2);
    expect(readHold(board)?.reason.startsWith(CANARY_HOLD_PREFIX)).toBe(true);
  });

  it('a filing failure still holds the board and is reported', () => {
    event('pipeline-canary-red', 'r1', '2026-10-22T10:00:00Z');
    const r = run(true);
    expect(readHold(board)).not.toBeNull();
    expect(r.filed).toBeUndefined();
    expect(r.errors[0]).toContain('cli-file refused');
  });

  it('ignores other events, unreadable records and a missing events dir', () => {
    expect(run()).toEqual({ errors: [] });
    const dir = path.join(board, 'events');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'bad.json'), 'nope');
    writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ kind: 'check_run' }));
    writeFileSync(path.join(dir, 'half.json'), JSON.stringify({ kind: 'pipeline-canary-red' }));
    writeFileSync(path.join(dir, 'note.txt'), 'x');
    expect(run()).toEqual({ errors: [] });
    expect(readHold(board)).toBeNull();
  });
});

describe('hotfix task text', () => {
  it('carries the pipeline-hotfix label, the sha and the canary output', () => {
    const md = hotfixTaskMarkdown('HOTFIX-1', SHA, 'boom');
    expect(md).toContain('  - pipeline-hotfix');
    expect(md).toContain(SHA);
    expect(md).toContain('boom');
    expect(hotfixTaskMarkdown('HOTFIX-1', SHA, ' ')).toContain('(no output captured)');
    expect(hotfixTaskId(SHA)).toMatch(/^HOTFIX-\d+$/);
  });
});
