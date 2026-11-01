import { describe, expect, it } from 'vitest';
import {
  WORKTREE_SWEEP_DEFAULTS as C,
  isRemoval,
  worktreeDisposition,
  type WorktreeFacts,
} from './00-worktree-disposition.js';

const H = 3_600_000;
const base: WorktreeFacts = {
  onBoardInflight: false,
  sentinelAgeMs: null,
  prState: null,
  dirAgeMs: 100 * H,
  headAgeMs: 1 * H,
};

describe('worktreeDisposition (AISDLC-1108)', () => {
  const table: Array<[string, Partial<WorktreeFacts>, string]> = [
    [
      'inflight on the board beats a merged PR',
      { onBoardInflight: true, prState: 'MERGED' },
      'keep-inflight',
    ],
    [
      'fresh sentinel beats a closed PR',
      { sentinelAgeMs: 1 * H, prState: 'CLOSED' },
      'keep-inflight',
    ],
    [
      'old sentinel does not protect',
      { sentinelAgeMs: 25 * H, prState: 'MERGED' },
      'remove-merged',
    ],
    ['open PR, recent head', { prState: 'OPEN' }, 'keep-open-pr'],
    ['open PR, unknown head age', { prState: 'OPEN', headAgeMs: null }, 'keep-open-pr'],
    ['merged', { prState: 'MERGED' }, 'remove-merged'],
    ['closed unmerged', { prState: 'CLOSED' }, 'remove-closed'],
    ['no PR past the grace window', { dirAgeMs: 7 * H }, 'remove-no-pr'],
    ['no PR inside the grace window', { dirAgeMs: 1 * H }, 'keep-inflight'],
    ['open PR with a 15 day old head', { prState: 'OPEN', headAgeMs: 15 * 24 * H }, 'remove-stale'],
  ];
  it.each(table)('%s', (_n, facts, want) => {
    expect(worktreeDisposition({ ...base, ...facts }, C)).toBe(want);
  });

  it('defaults the config and tells removals from keeps', () => {
    expect(worktreeDisposition({ ...base, prState: 'MERGED' })).toBe('remove-merged');
    expect(isRemoval('remove-stale')).toBe(true);
    expect(isRemoval('keep-open-pr')).toBe(false);
  });
});
