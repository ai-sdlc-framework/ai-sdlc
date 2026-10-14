import { describe, expect, it } from 'vitest';
import { isRebaseOnlyPush } from './rebase-rearm.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);

function run(
  ids: Record<string, string | null>,
  bases: Record<string, string | null> = { [A]: M1, [B]: M2 },
  prev = A,
  next = B,
) {
  return isRebaseOnlyPush({
    previousHead: prev,
    newHead: next,
    repoRoot: '/x',
    deps: {
      mergeBase: (_r, head) => bases[head] ?? null,
      patchId: (_b, head) => ids[head] ?? null,
    },
  });
}

describe('isRebaseOnlyPush', () => {
  it('is true for identical patch-ids', () => {
    expect(run({ [A]: 'p'.repeat(40), [B]: 'p'.repeat(40) }).rebaseOnly).toBe(true);
  });
  it('is false when the patch-id changes', () => {
    const r = run({ [A]: 'p'.repeat(40), [B]: 'q'.repeat(40) });
    expect(r.rebaseOnly).toBe(false);
    expect(r.reason).toContain('patch-id changed');
  });
  it('fails closed on missing patch-id', () => {
    expect(run({ [A]: 'p'.repeat(40) }).rebaseOnly).toBe(false);
  });
  it('fails closed on missing merge-base', () => {
    expect(run({ [A]: 'p'.repeat(40), [B]: 'p'.repeat(40) }, { [A]: M1 }).rebaseOnly).toBe(false);
  });
  it('treats an unchanged head as rebase-only', () => {
    expect(run({}, {}, A, A).rebaseOnly).toBe(true);
  });
});
