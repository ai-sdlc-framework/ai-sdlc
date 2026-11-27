import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cachedGh,
  GH_NEGATIVE_TTL_MS,
  GH_READ_TTL_MS,
  useGhReadCacheDir,
} from './gh-read-cache.js';
import { allowedAuthors, gatherDocsBump, gatherMainHealth } from './reconcile.js';
import type { CommandRunner } from './types.js';

function fake(answer: (args: readonly string[]) => string) {
  const calls: string[][] = [];
  const run: CommandRunner = (_f, args) => {
    calls.push([...args]);
    return { status: 0, stdout: answer(args), stderr: '' };
  };
  return { run, calls };
}
const count = (calls: string[][], needle: string) => calls.filter((c) => c.includes(needle)).length;

describe('cachedGh', () => {
  it('reuses a success until the ttl and a failure for the short negative ttl', () => {
    let t = 0;
    let status = 1;
    const calls: number[] = [];
    const run: CommandRunner = () => {
      calls.push(t);
      return { status, stdout: 'x', stderr: '' };
    };
    const ttl = 10 * GH_NEGATIVE_TTL_MS;
    cachedGh(run, 'k', ['a'], {}, ttl, () => t);
    cachedGh(run, 'k', ['a'], {}, ttl, () => t);
    expect(calls).toHaveLength(1);
    t = GH_NEGATIVE_TTL_MS;
    status = 0;
    cachedGh(run, 'k', ['a'], {}, ttl, () => t);
    cachedGh(run, 'k', ['a'], {}, ttl, () => t);
    expect(calls).toHaveLength(2);
    t += ttl;
    cachedGh(run, 'k', ['a'], {}, ttl, () => t);
    expect(calls).toHaveLength(3);
  });

  describe('across processes (AISDLC-1440)', () => {
    let board: string;
    beforeEach(() => {
      board = mkdtempSync(path.join(tmpdir(), 'gh-read-cache-'));
      useGhReadCacheDir(board);
    });
    afterEach(() => {
      useGhReadCacheDir(undefined);
      rmSync(board, { recursive: true, force: true });
    });

    it('a second process within the ttl makes no gh call', () => {
      const first = fake(() => 'Me\n');
      expect(allowedAuthors(first.run, '/r', {})).toEqual(new Set(['me']));
      // A new runner has an empty memory, like a new process; only the disk is shared.
      const second = fake(() => 'Other\n');
      expect(allowedAuthors(second.run, '/r', {})).toEqual(new Set(['me']));
      expect(second.calls).toHaveLength(0);
    });

    it('a 404 is cached negatively for the short ttl only', () => {
      let t = 0;
      const calls: string[][] = [];
      const run: CommandRunner = (_f, args) => {
        calls.push([...args]);
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      };
      const other: CommandRunner = (f, a, o) => run(f, a, o);
      cachedGh(run, 'ref', ['api', 'x'], {}, GH_READ_TTL_MS, () => t);
      t = GH_NEGATIVE_TTL_MS - 1;
      expect(cachedGh(other, 'ref', ['api', 'x'], {}, GH_READ_TTL_MS, () => t).status).toBe(1);
      expect(calls).toHaveLength(1);
      t = GH_NEGATIVE_TTL_MS;
      cachedGh(other, 'ref', ['api', 'x'], {}, GH_READ_TTL_MS, () => t);
      expect(calls).toHaveLength(2);
    });

    it('an events read is refreshed by a newer webhook event record', () => {
      const t = Date.now();
      const { run, calls } = fake(() => '[]');
      const events = path.join(board, 'events');
      mkdirSync(events, { recursive: true });
      const at = new Date(t - 60_000);
      const old = path.join(events, `${encodeURIComponent('o/r#none@abc:workflow_run:1')}.json`);
      writeFileSync(old, '{}');
      utimesSync(old, at, at);
      cachedGh(run, 'runs', ['run', 'list'], { events: true }, GH_READ_TTL_MS, () => t);
      cachedGh(run, 'runs', ['run', 'list'], { events: true }, GH_READ_TTL_MS, () => t);
      expect(calls).toHaveLength(1);
      const fresh = path.join(events, `${encodeURIComponent('o/r#none@abc:workflow_run:2')}.json`);
      writeFileSync(fresh, '{}');
      const later = new Date(t + 1000);
      utimesSync(fresh, later, later);
      cachedGh(run, 'runs', ['run', 'list'], { events: true }, GH_READ_TTL_MS, () => t + 2000);
      expect(calls).toHaveLength(2);
      // Without the events option the record does not matter.
      cachedGh(run, 'plain', ['api', 'y'], {}, GH_READ_TTL_MS, () => t);
      cachedGh(run, 'plain', ['api', 'y'], {}, GH_READ_TTL_MS, () => t + 2000);
      expect(calls).toHaveLength(3);
    });

    it('an unreadable cache file is a miss', () => {
      const { run, calls } = fake(() => 'Me\n');
      allowedAuthors(run, '/r', {});
      const dir = path.join(board, 'gh-cache');
      for (const f of readdirSync(dir)) writeFileSync(path.join(dir, f), 'not json');
      allowedAuthors(fake(() => 'Me\n').run, '/r', {});
      const third = fake(() => 'Me\n');
      allowedAuthors(third.run, '/r', {});
      expect(calls).toHaveLength(1);
      expect(third.calls).toHaveLength(0);
    });
  });
});

describe('cached dispatch reads (AISDLC-1380)', () => {
  it('reads the gh login once across passes', () => {
    const { run, calls } = fake(() => 'Me\n');
    expect([...allowedAuthors(run, '/r', {})!]).toEqual(['me']);
    allowedAuthors(run, '/r', {});
    expect(count(calls, 'user')).toBe(1);
  });

  it('reads main health once per sha and again when the sha changes', () => {
    let sha = 'a'.repeat(40);
    const { run, calls } = fake((args) =>
      args.includes('--jq') && args[1]?.includes('commits/main')
        ? sha
        : JSON.stringify([{ conclusion: 'success', url: 'u' }]),
    );
    expect(gatherMainHealth(run, '/r').status).toBe('green');
    gatherMainHealth(run, '/r');
    expect(count(calls, 'list')).toBe(1);
    expect(calls.filter((c) => c[1]?.includes('commits/main'))).toHaveLength(1);
    // A new sha is a new key for the run list even while the sha read is cached.
    const other = fake((args) =>
      args[1]?.includes('commits/main') ? sha : JSON.stringify([{ conclusion: 'failure' }]),
    );
    sha = 'b'.repeat(40);
    expect(gatherMainHealth(other.run, '/r').status).toBe('red');
  });

  it('reads the docs-bump run view once per run id', () => {
    let id = 1;
    const { run, calls } = fake((args) =>
      args[1] === 'list'
        ? JSON.stringify([{ databaseId: id, conclusion: 'success', url: 'u' }])
        : JSON.stringify({ jobs: [] }),
    );
    gatherDocsBump(run, '/r');
    gatherDocsBump(run, '/r');
    expect(count(calls, 'view')).toBe(1);
    expect(count(calls, 'list')).toBe(1);
    // A different run id is a different view key.
    id = 2;
    const next = fake((args) =>
      args[1] === 'list'
        ? JSON.stringify([{ databaseId: id, conclusion: 'success', url: 'u' }])
        : JSON.stringify({ jobs: [] }),
    );
    gatherDocsBump(next.run, '/r');
    expect(count(next.calls, 'view')).toBe(1);
  });
});
