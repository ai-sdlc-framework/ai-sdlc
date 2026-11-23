import { describe, expect, it, vi } from 'vitest';

const merge = vi.hoisted(() => vi.fn());
vi.mock('../governance/merge-if-eligible.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../governance/merge-if-eligible.js')>()),
  resolveTargetRepo: async () => ({ slug: 'o/r', reason: undefined }),
  runMergeIfEligible: merge,
}));

import { docsLanePathRefusal } from '../governance/merge-if-eligible.js';
import { createLander } from './land-eligible.js';

const ok = { merged: true, armed: false, eligibility: { reason: 'ok' } };

describe('createLander source kind (AISDLC-1374)', () => {
  const kindFor = async (branch: string | undefined): Promise<string> => {
    merge.mockClear();
    merge.mockResolvedValue(ok);
    await createLander({ repoRoot: '/repo' })(1, 'merge', branch);
    return (merge.mock.calls[0]![0] as { sourceKind: string }).sourceKind;
  };

  it('lands a decision filing PR and a task filing PR as docs', async () => {
    expect(await kindFor('ai-sdlc/file-dec-0422-opened-1200')).toBe('docs');
    expect(await kindFor('ai-sdlc/file-aisdlc-1374')).toBe('docs');
  });

  it('keeps backlog for task PRs', async () => {
    expect(await kindFor('ai-sdlc/issue-12')).toBe('backlog');
    expect(await kindFor('feat/thing')).toBe('backlog');
    expect(await kindFor(undefined)).toBe('backlog');
  });
});

describe('docs lane path gate (AISDLC-1374)', () => {
  it('refuses a file-* branch whose diff touches a source file', () => {
    expect(docsLanePathRefusal([{ path: 'pipeline-cli/src/x.ts' } as never])).toMatch(
      /outside the docs-only list/,
    );
    expect(docsLanePathRefusal([{ path: 'docs/a.md' } as never])).toBeNull();
  });
});
