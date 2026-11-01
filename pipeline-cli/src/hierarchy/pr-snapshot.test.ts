import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeEventRecord } from '../dispatch/webhook-receiver.js';
import {
  createSnapshotRunner,
  prFingerprint,
  recordRefusal,
  refusalStillValid,
  SNAPSHOT_MAX_AGE_MS,
} from './pr-snapshot.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'snap-'));
});
afterEach(() => removeFixtureDir(board));

const prs = Array.from({ length: 10 }, (_, i) => ({
  number: i + 1,
  title: `t${i}`,
  isDraft: i % 2 === 0,
  headRefOid: 'a'.repeat(40),
  statusCheckRollup: [{ name: 'x', conclusion: 'SUCCESS' }],
}));

function fake() {
  const calls: string[][] = [];
  const run: CommandRunner = (_f, args) => {
    calls.push([...args]);
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
  return { run, calls };
}

const listArgs = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title'];

function wake(run: CommandRunner, at: Date) {
  const r = createSnapshotRunner(run, { boardDir: board, now: () => at });
  const a = r('gh', listArgs);
  r('gh', ['pr', 'list', '--state', 'open', '--draft', '--json', 'number,isDraft']);
  for (let n = 1; n <= 10; n++) r('gh', ['pr', 'view', String(n), '--json', 'statusCheckRollup']);
  return a;
}

describe('createSnapshotRunner', () => {
  it('shares one list call across consumers and serves rollup views from it', () => {
    const { run, calls } = fake();
    const out = wake(run, new Date('2026-01-01T00:00:00Z'));
    expect(JSON.parse(out.stdout)).toHaveLength(10);
    expect(calls.filter((c) => c[1] === 'list')).toHaveLength(1);
    expect(calls.filter((c) => c[1] === 'view')).toHaveLength(0);
  });

  it('second wake with ten PRs and no new events makes zero gh calls', () => {
    const { run, calls } = fake();
    mkdirSync(path.join(board, 'events'));
    wake(run, new Date());
    calls.length = 0;
    wake(run, new Date());
    expect(calls).toHaveLength(0);
  });

  it('refreshes once when an event is newer, or the snapshot is 15 minutes old', () => {
    const { run, calls } = fake();
    mkdirSync(path.join(board, 'events'));
    const t0 = new Date();
    wake(run, t0);
    calls.length = 0;
    writeEventRecord(path.join(board, 'events'), {
      repo: 'o/r',
      pr: 3,
      headSha: 'b'.repeat(40),
      kind: 'check_run',
      deliveryId: 'd1',
      receivedAt: new Date(Date.now() + 5000).toISOString(),
    });
    const future = new Date(Date.now() + 60_000);
    // event file mtime is "now"; the stored snapshot predates it only if fetchedAt < mtime.
    wake(run, new Date(t0.getTime() - 1));
    expect(calls.filter((c) => c[1] === 'list').length).toBeLessThanOrEqual(1);
    calls.length = 0;
    wake(run, new Date(future.getTime() + SNAPSHOT_MAX_AGE_MS));
    expect(calls.filter((c) => c[1] === 'list')).toHaveLength(1);
  });

  it('without a receiver every wake lists once', () => {
    const { run, calls } = fake();
    wake(run, new Date());
    calls.length = 0;
    wake(run, new Date());
    expect(calls.filter((c) => c[1] === 'list')).toHaveLength(1);
  });

  it('drops the snapshot when a PR is changed', () => {
    const { run, calls } = fake();
    mkdirSync(path.join(board, 'events'));
    wake(run, new Date());
    const r = createSnapshotRunner(run, { boardDir: board });
    r('gh', ['pr', 'ready', '3']);
    calls.length = 0;
    r('gh', listArgs);
    expect(calls.filter((c) => c[1] === 'list')).toHaveLength(1);
  });

  it('reports a failed list', () => {
    const run: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'boom' });
    const r = createSnapshotRunner(run, { boardDir: board });
    expect(r('gh', listArgs).status).toBe(1);
    writeFileSync(path.join(board, 'x'), '');
    const bad: CommandRunner = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(createSnapshotRunner(bad, { boardDir: board })('gh', listArgs).status).toBe(1);
  });
});

describe('fingerprints', () => {
  it('a refusal is valid until the fingerprint changes or 15 minutes pass', () => {
    const p = { number: 4, headRefOid: 'a'.repeat(40), statusCheckRollup: [] };
    const fp = prFingerprint(board, p);
    const t0 = new Date('2026-01-01T00:00:00Z');
    recordRefusal(board, 4, fp, t0);
    expect(refusalStillValid(board, 4, fp, new Date(t0.getTime() + 1000))).toBe(true);
    expect(refusalStillValid(board, 4, prFingerprint(board, { ...p, headRefOid: 'c' }), t0)).toBe(
      false,
    );
    expect(refusalStillValid(board, 4, fp, new Date(t0.getTime() + SNAPSHOT_MAX_AGE_MS))).toBe(
      false,
    );
    recordRefusal(board, 4, undefined, t0);
    expect(refusalStillValid(board, 4, fp, t0)).toBe(false);
  });
});
