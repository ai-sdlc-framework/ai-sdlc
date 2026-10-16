import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  claimNext,
  ensureBoardDirs,
  findUndeliveredPr,
  UndeliveredPrError,
  writeManifest,
} from './board.js';
import type { DispatchManifest } from './types.js';

function mk(taskId: string, extra: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-10-16T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: [] },
    ...extra,
  };
}

function board(record?: Record<string, unknown>): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'undelivered-')), 'dispatch');
  ensureBoardDirs(dir);
  if (record) {
    mkdirSync(path.join(dir, 'landing'), { recursive: true });
    writeFileSync(path.join(dir, 'landing', `${record.pr}.json`), JSON.stringify(record));
  }
  writeFileSync(path.join(dir, 'landing', 'bad.json'), '{', { flag: 'a' });
  return dir;
}

const rec = {
  pr: 7,
  owner: 'executor:alpha',
  taskId: 'AISDLC-1',
  state: 'ci-pending',
  history: [],
};

describe('undelivered PR claim pause (AISDLC-816)', () => {
  it('refuses a fresh task and names the PR', () => {
    const dir = board(rec);
    writeManifest(dir, mk('AISDLC-2'));
    expect(() => claimNext(dir, 'in-session-agent', undefined, { workerId: 'alpha' })).toThrow(
      UndeliveredPrError,
    );
    expect(() => claimNext(dir, 'in-session-agent', undefined, { workerId: 'alpha' })).toThrow(
      /#7/,
    );
  });

  it('lets a fixesPr task through and ignores other executors', () => {
    const dir = board(rec);
    writeManifest(dir, mk('AISDLC-2'));
    writeManifest(dir, mk('AISDLC-3', { fixesPr: 7 }));
    const r = claimNext(dir, 'in-session-agent', undefined, { workerId: 'alpha' });
    expect(r.manifest?.taskId).toBe('AISDLC-3');
    expect(findUndeliveredPr(dir, 'beta')).toBeUndefined();
  });

  it('does not block on a delivered PR', () => {
    const dir = board({ ...rec, delivered: '2026-10-16T10:00:00Z' });
    writeManifest(dir, mk('AISDLC-2'));
    expect(claimNext(dir, 'in-session-agent', undefined, { workerId: 'alpha' }).claimed).toBe(true);
  });
});
