/**
 * `dispatch-board` doctor check (AISDLC-800): the four board invariants.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setClock } from '../../clock.js';
import {
  buildProductionCheckAdapters,
  checkDispatchBoard,
  DOCTOR_CHECKS,
  type DoctorCheckResult,
} from './doctor-checks.js';

let dir: string;
let board: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-dispatch-board-'));
  board = join(dir, '.ai-sdlc', 'dispatch');
  for (const sub of ['queue', 'inflight', 'done']) mkdirSync(join(board, sub), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(sub: string, file: string, body: unknown): void {
  writeFileSync(join(board, sub, file), JSON.stringify(body));
}
function inflight(taskId: string, workerId: string, beatAgoMs: number | null): void {
  put('inflight', `${taskId}.dispatch.json`, { taskId, workerId });
  if (beatAgoMs !== null) {
    put('inflight', `${taskId}.state.json`, {
      taskId,
      lastHeartbeat: new Date(Date.now() - beatAgoMs).toISOString(),
    });
  }
}
function run(): Record<string, DoctorCheckResult> {
  const results = checkDispatchBoard({ projectDir: dir, adapters: buildProductionCheckAdapters() });
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

describe('checkDispatchBoard', () => {
  it('is registered as dispatch-board', () => {
    expect(DOCTOR_CHECKS.some((c) => c.id === 'dispatch-board')).toBe(true);
  });

  it('is quiet when there is no board, or no way to list files', () => {
    rmSync(board, { recursive: true });
    expect(run()).toEqual({});
    const adapters = { ...buildProductionCheckAdapters(), listFiles: undefined };
    mkdirSync(board, { recursive: true });
    expect(checkDispatchBoard({ projectDir: dir, adapters })).toEqual([]);
  });

  it('passes all four invariants on a healthy board', () => {
    inflight('AISDLC-1', 'exec-a', 1000);
    inflight('AISDLC-2', 'exec-b', 1000);
    const r = run();
    expect(Object.keys(r)).toHaveLength(4);
    expect(Object.values(r).every((x) => x.severity === 'pass')).toBe(true);
  });

  it('fails when a worker holds two claims', () => {
    inflight('AISDLC-1', 'exec-a', 1000);
    inflight('AISDLC-2', 'exec-a', 1000);
    const r = run()['dispatch-board-one-claim-per-worker'];
    expect(r.severity).toBe('fail');
    expect(r.title).toContain('exec-a holds AISDLC-1 and AISDLC-2');
  });

  it('warns on a missing or stale heartbeat', () => {
    inflight('AISDLC-1', 'exec-a', null);
    inflight('AISDLC-2', 'exec-b', 40 * 60 * 1000);
    put('inflight', 'AISDLC-3.dispatch.json', { taskId: 'AISDLC-3', workerId: 'exec-c' });
    writeFileSync(join(board, 'inflight', 'AISDLC-3.state.json'), 'not json');
    const r = run()['dispatch-board-heartbeat'];
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('AISDLC-1 (no heartbeat)');
    expect(r.title).toContain('AISDLC-2 (stale heartbeat)');
    expect(r.title).toContain('AISDLC-3 (no heartbeat)');
  });

  it('fails when a resume manifest carries a wave, ignoring waves on plain entries', () => {
    put('queue', 'AISDLC-4.dispatch.json', { taskId: 'AISDLC-4', wave: 2, resume: { note: 'x' } });
    put('queue', 'AISDLC-5.dispatch.json', { taskId: 'AISDLC-5', wave: 2 });
    const r = run()['dispatch-board-resume-wave'];
    expect(r.severity).toBe('fail');
    expect(r.title).toContain('AISDLC-4');
    expect(r.title).not.toContain('AISDLC-5');
  });

  it('warns on an old iterate-needed verdict whose claim is held or gone, not when released', () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    const verdict = (taskId: string, outcome: string, completedAt?: string) =>
      put('done', `${taskId}.verdict.json`, { taskId, outcome, completedAt });
    verdict('AISDLC-6', 'iterate-needed', old);
    inflight('AISDLC-6', 'exec-a', 1000);
    verdict('AISDLC-7', 'iterate-needed', old);
    verdict('AISDLC-8', 'iterate-needed', old);
    put('queue', 'AISDLC-8.dispatch.json', { taskId: 'AISDLC-8' });
    verdict('AISDLC-9', 'iterate-needed', fresh);
    verdict('AISDLC-10', 'success', old);
    verdict('AISDLC-11', 'iterate-needed');
    const r = run()['dispatch-board-stale-verdict'];
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('AISDLC-6');
    expect(r.title).toContain('AISDLC-7');
    expect(r.title).not.toMatch(/AISDLC-(8|9|10)\b/);
  });

  it('falls back to the verdict file mtime when completedAt is missing', () => {
    put('done', 'AISDLC-12.verdict.json', { taskId: 'AISDLC-12', outcome: 'iterate-needed' });
    expect(run()['dispatch-board-stale-verdict'].severity).toBe('pass');
    const adapters = { ...buildProductionCheckAdapters(), fileMtimeMs: () => 1000 };
    const results = checkDispatchBoard({ projectDir: dir, adapters });
    const stale = results.find((x) => x.id === 'dispatch-board-stale-verdict');
    expect(stale?.severity).toBe('warn');
    expect(stale?.title).toContain('AISDLC-12');
  });

  it('reads the pinned clock when judging heartbeat age', () => {
    inflight('AISDLC-13', 'exec-a', 1000);
    const restore = setClock(() => new Date(Date.now() + 3 * 60 * 60 * 1000));
    try {
      expect(run()['dispatch-board-heartbeat'].severity).toBe('warn');
    } finally {
      restore();
    }
  });
});
