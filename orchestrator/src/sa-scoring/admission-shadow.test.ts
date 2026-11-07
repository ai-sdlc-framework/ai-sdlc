import { describe, it, expect, vi } from 'vitest';
import type { DesignIntentDocument } from '@ai-sdlc/reference';

const scoreMock = vi.fn(async () => ({}));
vi.mock('./index.js', () => ({ scoreSoulAlignment: (...a: unknown[]) => scoreMock(...(a as [])) }));

import { createSoulAlignmentShadow } from './admission-shadow.js';
import { computeAdmissionComposite } from '../admission-composite.js';

describe('SA engine call count at admission', () => {
  it('calls the engine exactly once per admission, in phase 2a', () => {
    scoreMock.mockClear();
    const shadow = createSoulAlignmentShadow({
      did: {} as DesignIntentDocument,
      deps: {} as never,
      issueText: () => 'text',
    });
    computeAdmissionComposite(
      {
        issueNumber: 1,
        title: 't',
        body: 'b',
        labels: [],
        reactionCount: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
      },
      undefined,
      { soulAlignmentShadow: shadow },
    );
    expect(scoreMock).toHaveBeenCalledTimes(1);
    const arg = (scoreMock.mock.calls[0] as unknown[])[0] as { phase: string; claimRank: unknown };
    expect(arg.phase).toBe('2a');
    expect(arg.claimRank).toBeNull();
  });
});
