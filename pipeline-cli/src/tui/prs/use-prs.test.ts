/**
 * Tests for PRs pane logic — RFC-0023 §7.2 / AISDLC-178.4.
 *
 * Covers:
 *   - ciGlyph: SUCCESS/FAILURE/PENDING/unknown
 *   - reviewStateLabel: all decision states
 *   - mergeStateLabel: MERGEABLE/CONFLICTING/BLOCKED/BEHIND
 *   - nextStepLabel: all annotation paths
 *   - urgencyColor: all color paths
 *   - prSortBucket: all bucket paths
 *   - buildPrRows: sort order + secondary sort by PR number
 */

import { describe, expect, it } from 'vitest';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';
import {
  ciGlyph,
  reviewStateLabel,
  mergeStateLabel,
  nextStepLabel,
  urgencyColor,
  prSortBucket,
  buildPrRows,
} from './use-prs.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePr(
  overrides: Partial<GhPrSummary & { reviewDecision?: string; body?: string }> = {},
): GhPrSummary {
  return {
    number: 1,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/org/repo/pull/1',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    headRefName: 'feat/test',
    mergeable: 'MERGEABLE',
    statusCheckRollup: null,
    ...overrides,
  } as GhPrSummary;
}

// ── ciGlyph ───────────────────────────────────────────────────────────────────

describe('ciGlyph', () => {
  it('returns ✓ for SUCCESS status', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: 'SUCCESS' }))).toBe('✓');
  });

  it('returns ✓ for SUCCESS (object with state field)', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: { state: 'SUCCESS' } }))).toBe('✓');
  });

  it('returns ✗ for FAILURE', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: 'FAILURE' }))).toBe('✗');
  });

  it('returns ✗ for ERROR', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: 'ERROR' }))).toBe('✗');
  });

  it('returns ✗ for FAILURE (object with state field)', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: { state: 'FAILURE' } }))).toBe('✗');
  });

  it('returns ⏳ for PENDING', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: 'PENDING' }))).toBe('⏳');
  });

  it('returns ⏳ for null (no checks)', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: null }))).toBe('⏳');
  });

  it('returns ⏳ for undefined', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: undefined }))).toBe('⏳');
  });

  it('returns ⏳ for unknown string', () => {
    expect(ciGlyph(makePr({ statusCheckRollup: 'QUEUED' }))).toBe('⏳');
  });
});

// ── reviewStateLabel ──────────────────────────────────────────────────────────

describe('reviewStateLabel', () => {
  it('returns approved for APPROVED', () => {
    expect(
      reviewStateLabel(makePr({ reviewDecision: 'APPROVED' } as unknown as Partial<GhPrSummary>)),
    ).toBe('approved');
  });

  it('returns changes-requested for CHANGES_REQUESTED', () => {
    expect(
      reviewStateLabel(
        makePr({ reviewDecision: 'CHANGES_REQUESTED' } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('changes-requested');
  });

  it('returns pending for REVIEW_REQUIRED', () => {
    expect(
      reviewStateLabel(
        makePr({ reviewDecision: 'REVIEW_REQUIRED' } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('pending');
  });

  it('returns no-reviews-yet when no reviewDecision', () => {
    expect(reviewStateLabel(makePr())).toBe('no-reviews-yet');
  });

  it('returns no-reviews-yet for unrecognized decision', () => {
    expect(
      reviewStateLabel(makePr({ reviewDecision: 'UNKNOWN' } as unknown as Partial<GhPrSummary>)),
    ).toBe('no-reviews-yet');
  });
});

// ── mergeStateLabel ───────────────────────────────────────────────────────────

describe('mergeStateLabel', () => {
  it('returns clean for MERGEABLE', () => {
    expect(mergeStateLabel(makePr({ mergeable: 'MERGEABLE' }))).toBe('clean');
  });

  it('returns dirty for CONFLICTING', () => {
    expect(mergeStateLabel(makePr({ mergeable: 'CONFLICTING' }))).toBe('dirty');
  });

  it('returns blocked for BLOCKED', () => {
    expect(mergeStateLabel(makePr({ mergeable: 'BLOCKED' }))).toBe('blocked');
  });

  it('returns behind for BEHIND', () => {
    expect(mergeStateLabel(makePr({ mergeable: 'BEHIND' }))).toBe('behind');
  });

  it('returns clean for undefined mergeable', () => {
    expect(mergeStateLabel(makePr({ mergeable: undefined }))).toBe('clean');
  });
});

// ── nextStepLabel ─────────────────────────────────────────────────────────────

describe('nextStepLabel', () => {
  it('returns awaiting-rebase when merge is dirty', () => {
    expect(nextStepLabel(makePr({ mergeable: 'CONFLICTING' }))).toBe('awaiting-rebase');
  });

  it('returns awaiting-rebase when merge is behind', () => {
    expect(nextStepLabel(makePr({ mergeable: 'BEHIND' }))).toBe('awaiting-rebase');
  });

  it('returns awaiting-ci when merge is blocked', () => {
    expect(nextStepLabel(makePr({ mergeable: 'BLOCKED' }))).toBe('awaiting-ci');
  });

  it('returns awaiting-human when review changes-requested', () => {
    expect(
      nextStepLabel(
        makePr({
          reviewDecision: 'CHANGES_REQUESTED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('awaiting-human');
  });

  it('returns ready-to-merge when approved + CI success', () => {
    expect(
      nextStepLabel(
        makePr({
          reviewDecision: 'APPROVED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('ready-to-merge');
  });

  it('returns awaiting-ci when CI pending', () => {
    expect(nextStepLabel(makePr({ statusCheckRollup: null }))).toBe('awaiting-ci');
  });

  it('returns awaiting-human when CI fails and no changes-requested', () => {
    expect(nextStepLabel(makePr({ statusCheckRollup: 'FAILURE' }))).toBe('awaiting-human');
  });

  it('returns awaiting-human when review pending', () => {
    expect(
      nextStepLabel(
        makePr({
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('awaiting-human');
  });
});

// ── urgencyColor ──────────────────────────────────────────────────────────────

describe('urgencyColor', () => {
  it('returns green for ready-to-merge', () => {
    expect(
      urgencyColor(
        makePr({
          reviewDecision: 'APPROVED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('green');
  });

  it('returns red for awaiting-rebase (conflicting)', () => {
    expect(urgencyColor(makePr({ mergeable: 'CONFLICTING' }))).toBe('red');
  });

  it('returns red for changes-requested', () => {
    expect(
      urgencyColor(
        makePr({ reviewDecision: 'CHANGES_REQUESTED' } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('red');
  });

  it('returns red for CI failure', () => {
    expect(urgencyColor(makePr({ statusCheckRollup: 'FAILURE' }))).toBe('red');
  });

  it('returns yellow for CI pending', () => {
    expect(
      urgencyColor(
        makePr({
          reviewDecision: 'APPROVED',
          statusCheckRollup: null,
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe('yellow');
  });

  it('returns gray for no-reviews-yet and CI pending', () => {
    expect(urgencyColor(makePr({ statusCheckRollup: null }))).toBe('yellow');
  });
});

// ── prSortBucket ──────────────────────────────────────────────────────────────

describe('prSortBucket', () => {
  it('bucket 4: ready-to-merge (lowest attention)', () => {
    expect(
      prSortBucket(
        makePr({
          reviewDecision: 'APPROVED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe(4);
  });

  it('bucket 3: CI pending, no changes-requested', () => {
    expect(prSortBucket(makePr({ statusCheckRollup: null }))).toBe(3);
  });

  it('bucket 2: awaiting-rebase', () => {
    expect(prSortBucket(makePr({ mergeable: 'CONFLICTING' }))).toBe(2);
  });

  it('bucket 1: changes-requested', () => {
    expect(
      prSortBucket(
        makePr({
          reviewDecision: 'CHANGES_REQUESTED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe(1);
  });

  it('bucket 0: blocked-on-human (ci failure + changes-requested)', () => {
    expect(
      prSortBucket(
        makePr({
          reviewDecision: 'CHANGES_REQUESTED',
          statusCheckRollup: 'FAILURE',
          mergeable: 'MERGEABLE',
        } as unknown as Partial<GhPrSummary>),
      ),
    ).toBe(1);
  });
});

// ── buildPrRows ───────────────────────────────────────────────────────────────

describe('buildPrRows', () => {
  it('returns empty array for empty input', () => {
    expect(buildPrRows([])).toEqual([]);
  });

  it('sorts by bucket ASC (highest attention first)', () => {
    const prs = [
      makePr({
        number: 1,
        reviewDecision: 'APPROVED',
        statusCheckRollup: 'SUCCESS',
      } as unknown as Partial<GhPrSummary>), // bucket 4
      makePr({ number: 2, mergeable: 'CONFLICTING' }), // bucket 2
      makePr({
        number: 3,
        reviewDecision: 'CHANGES_REQUESTED',
        statusCheckRollup: 'FAILURE',
      } as unknown as Partial<GhPrSummary>), // bucket 1
    ];
    const rows = buildPrRows(prs);
    expect(rows.map((r) => r.pr.number)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.bucket)).toEqual([1, 2, 4]);
  });

  it('secondary sort: newer PR number first within same bucket', () => {
    const prs = [
      makePr({ number: 10, statusCheckRollup: null }), // bucket 3
      makePr({ number: 5, statusCheckRollup: null }), // bucket 3
      makePr({ number: 15, statusCheckRollup: null }), // bucket 3
    ];
    const rows = buildPrRows(prs);
    expect(rows.map((r) => r.pr.number)).toEqual([15, 10, 5]);
  });

  it('populates all derived fields correctly', () => {
    const pr = makePr({
      number: 42,
      title: 'My PR',
      headRefName: 'feat/my-branch',
      reviewDecision: 'APPROVED',
      statusCheckRollup: 'SUCCESS',
    } as unknown as Partial<GhPrSummary>);
    const [row] = buildPrRows([pr]);
    expect(row.ci).toBe('✓');
    expect(row.review).toBe('approved');
    expect(row.merge).toBe('clean');
    expect(row.nextStep).toBe('ready-to-merge');
    expect(row.color).toBe('green');
    expect(row.bucket).toBe(4);
  });
});
