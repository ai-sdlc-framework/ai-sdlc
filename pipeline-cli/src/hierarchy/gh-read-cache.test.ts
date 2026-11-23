import { describe, expect, it } from 'vitest';

import { cachedGh } from './gh-read-cache.js';
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
  it('reuses a success, refetches after the ttl, and never stores a failure', () => {
    let t = 0;
    let status = 1;
    const calls: number[] = [];
    const run: CommandRunner = () => {
      calls.push(t);
      return { status, stdout: 'x', stderr: '' };
    };
    cachedGh(run, 'k', ['a'], {}, 10, () => t);
    cachedGh(run, 'k', ['a'], {}, 10, () => t);
    expect(calls).toHaveLength(2);
    status = 0;
    cachedGh(run, 'k', ['a'], {}, 10, () => t);
    cachedGh(run, 'k', ['a'], {}, 10, () => t);
    expect(calls).toHaveLength(3);
    t = 11;
    cachedGh(run, 'k', ['a'], {}, 10, () => t);
    expect(calls).toHaveLength(4);
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
