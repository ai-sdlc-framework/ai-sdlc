import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  annotateSnapshot,
  appendReconcileLog,
  formatPrTable,
  formatRow,
  reconcileLogPath,
  rowsForOpen,
} from './pr-rows.js';
import { landingPath, type LandingRecord } from './reconcile.js';
import { schedulerUp } from './reconcile-scheduler.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'pr-rows-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

function land(r: Partial<LandingRecord> & { pr: number }): void {
  const rec: LandingRecord = {
    kind: 'task',
    owner: 'machine',
    state: 'ci-red',
    action: 'rerun',
    history: [{ ts: '2026-10-29T00:00:00.000Z', state: 'ci-red', action: 'rerun' }],
    ...r,
  } as LandingRecord;
  mkdirSync(path.dirname(landingPath(board, r.pr)), { recursive: true });
  writeFileSync(landingPath(board, r.pr), JSON.stringify(rec));
}

describe('pr rows', () => {
  it('builds one row per open PR, with a release row when no record exists', () => {
    land({ pr: 1, failingLine: 'lint  failed' });
    const rows = rowsForOpen(board, [1, 2]);
    expect(rows.map((r) => r.pr)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ lane: 'task', action: 'rerun', reason: 'lint failed' });
    expect(rows[1]).toMatchObject({ lane: 'release', action: 'report' });
    expect(formatRow(rows[0]!)).toContain('lastActionAt=2026-10-29T00:00:00.000Z');
    expect(formatRow(rows[1]!)).not.toContain('lastActionAt');
  });

  it('appends rows to the log and skips an empty set', () => {
    appendReconcileLog(board, [], new Date());
    appendReconcileLog(board, rowsForOpen(board, [2]), new Date('2026-10-29T01:00:00Z'));
    const text = readFileSync(reconcileLogPath(board), 'utf-8');
    expect(text).toMatch(/^2026-10-29T01:00:00.000Z #2 lane=release/);
  });

  it('annotates the snapshot', () => {
    land({ pr: 1, note: 'held' });
    annotateSnapshot(board, rowsForOpen(board, [1]));
    writeFileSync(
      path.join(board, 'pr-snapshot.json'),
      JSON.stringify({ fetchedAt: 'x', prs: [{ number: 1 }, { number: 9 }] }),
    );
    annotateSnapshot(board, rowsForOpen(board, [1]));
    const snap = JSON.parse(readFileSync(path.join(board, 'pr-snapshot.json'), 'utf-8'));
    expect(snap.prs[0]).toMatchObject({ lane: 'task', owner: 'machine', reason: 'held' });
    expect(snap.prs[0].lastActionAt).toBeDefined();
    expect(snap.prs[1].lane).toBeUndefined();
    writeFileSync(path.join(board, 'pr-snapshot.json'), '{}');
    annotateSnapshot(board, []);
  });

  it('prints the status table for open records only', () => {
    expect(formatPrTable(board, Date.now())).toEqual([]);
    land({ pr: 1 });
    land({ pr: 2, landed: '2026-10-29T00:00:00.000Z' });
    const lines = formatPrTable(board, Date.parse('2026-10-29T02:10:00Z'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(
      '#1 lane task, action rerun, reason ci-red, owner machine, age 2h10m',
    );
  });

  it('starts the scheduler with its output on the reconcile log', () => {
    let logFile: string | undefined;
    schedulerUp({ boardDir: board, log: () => {}, isAlive: () => false } as never, (_f, _a, l) => {
      logFile = l;
      return 4242;
    });
    expect(logFile).toBe(reconcileLogPath(board));
  });
});
