import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearRuling, listRulings, readRuling, setRuling } from './ruling.js';

let board: string;
const NOW = () => new Date('2026-10-15T00:00:00.000Z');
const put = (sub: string, name: string, body: object) => {
  mkdirSync(path.join(board, sub), { recursive: true });
  writeFileSync(path.join(board, sub, name), JSON.stringify(body));
};

beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'ruling-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

describe('rulings on the board (AISDLC-903)', () => {
  it('writes and clears a ruling on a queue manifest', () => {
    put('queue', 'AISDLC-1.dispatch.json', { taskId: 'AISDLC-1', branch: 'b' });
    const r = setRuling(board, 'AISDLC-1', {
      text: 'hold',
      until: 'AISDLC-2',
      by: 'planner',
      now: NOW,
    });
    expect(r).toEqual({
      text: 'hold',
      until: 'AISDLC-2',
      by: 'planner',
      at: '2026-10-15T00:00:00.000Z',
    });
    expect(readRuling(board, 'AISDLC-1')?.text).toBe('hold');
    const raw = JSON.parse(
      readFileSync(path.join(board, 'queue', 'AISDLC-1.dispatch.json'), 'utf-8'),
    );
    expect(raw.branch).toBe('b');
    expect(listRulings(board).map((x) => x.taskId)).toEqual(['AISDLC-1']);
    expect(clearRuling(board, 'AISDLC-1')).toBe(true);
    expect(clearRuling(board, 'AISDLC-1')).toBe(false);
    expect(readRuling(board, 'AISDLC-1')).toBeUndefined();
  });

  it('writes onto the manifest snapshot in failed/', () => {
    put('failed', 'AISDLC-3.manifest.json', { taskId: 'AISDLC-3' });
    setRuling(board, 'AISDLC-3', { text: 'wait', now: NOW });
    expect(readRuling(board, 'AISDLC-3')?.text).toBe('wait');
  });

  it('writes in done/ onto an existing manifest, or onto a stub beside a done record', () => {
    put('done', 'AISDLC-4.manifest.json', { taskId: 'AISDLC-4' });
    setRuling(board, 'AISDLC-4', { text: 'a', now: NOW });
    put('done', 'AISDLC-5.completed.json', { taskId: 'AISDLC-5' });
    setRuling(board, 'AISDLC-5', { text: 'b', now: NOW });
    expect(listRulings(board).map((x) => x.taskId)).toEqual(['AISDLC-4', 'AISDLC-5']);
  });

  it('refuses on inflight/, an unknown task, bad ids and empty text', () => {
    put('inflight', 'AISDLC-6.dispatch.json', { taskId: 'AISDLC-6' });
    expect(() => setRuling(board, 'AISDLC-6', { text: 'x' })).toThrow(/inflight/);
    expect(() => clearRuling(board, 'AISDLC-6')).toThrow(/inflight/);
    expect(() => setRuling(board, 'AISDLC-7', { text: 'x' })).toThrow(/no manifest/);
    expect(() => setRuling(board, '../x', { text: 'x' })).toThrow(/valid task id/);
    expect(() => setRuling(board, 'AISDLC-7', { text: ' ' })).toThrow(/non-empty/);
    expect(() => setRuling(board, 'AISDLC-7', { text: 'x', until: 'bad' })).toThrow(
      /valid task id/,
    );
    expect(readRuling(board, 'nope')).toBeUndefined();
    expect(listRulings(path.join(board, 'missing'))).toEqual([]);
  });
});
