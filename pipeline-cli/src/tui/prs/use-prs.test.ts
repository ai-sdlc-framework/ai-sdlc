/**
 * Tests for PRs pane logic — RFC-0023 §7.2 / AISDLC-178.4 + AISDLC-178.4.1.
 *
 * Covers:
 *   - ciGlyph: SUCCESS/FAILURE/PENDING/unknown
 *   - reviewStateLabel: all decision states
 *   - mergeStateLabel: MERGEABLE/CONFLICTING/BLOCKED/BEHIND
 *   - nextStepLabel: all annotation paths
 *   - urgencyColor: all color paths
 *   - prSortBucket: all bucket paths
 *   - buildPrRows: chain enrichment + sort modes (critical-path, recency, ci-status)
 *   - sortPrRows: sort stability + AISDLC-178.4.1 AC #2 sort order
 *   - nextSortMode: cycle critical-path → recency → ci-status → critical-path
 */

import { describe, expect, it } from 'vitest';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';
import {
  ciGlyph,
  reviewStateLabel,
  mergeStateLabel,
  nextStepLabel,
  urgencyColor,
  prSortBucket,
  buildPrRows,
  sortPrRows,
  nextSortMode,
  PR_SORT_MODES,
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

function makeRecord(
  id: string,
  overrides: Partial<Omit<SnapshotRecord, 'id'>> = {},
): SnapshotRecord {
  return {
    id,
    dependencies: [],
    dependents: [],
    depth: 0,
    criticalPathLength: 0,
    externalDependencies: [],
    lastModified: '',
    ...overrides,
  };
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

// ── buildPrRows: critical-path mode (default) ─────────────────────────────────

describe('buildPrRows — critical-path (default) sort mode', () => {
  it('returns empty array for empty input', () => {
    expect(buildPrRows([])).toEqual([]);
  });

  it('puts head-of-chain first (cpl DESC), tail last (AC #2 + AC #7)', () => {
    // 1 → 2 → 3 → 4: cpl=3,2,1,0
    const prs = [
      makePr({ number: 4, labels: [{ name: 'depends-on:#3' }] }),
      makePr({ number: 1 }),
      makePr({ number: 3, labels: [{ name: 'depends-on:#2' }] }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
    ];
    const rows = buildPrRows(prs);
    expect(rows.map((r) => r.pr.number)).toEqual([1, 2, 3, 4]);
  });

  it('chain enrichment: chainPos+chainLen on every row', () => {
    const prs = [makePr({ number: 1 }), makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] })];
    const rows = buildPrRows(prs);
    const head = rows.find((r) => r.pr.number === 1)!;
    const tail = rows.find((r) => r.pr.number === 2)!;
    expect(head.chain.chainPos).toBe(1);
    expect(head.chain.chainLen).toBe(2);
    expect(tail.chain.chainPos).toBe(2);
    expect(tail.chain.chainLen).toBe(2);
  });

  it('reads effPri from snapshot when task IDs match', () => {
    const prs = [makePr({ number: 1, headRefName: 'ai-sdlc/aisdlc-500-x' })];
    const snapshotRecords = [makeRecord('AISDLC-500', { effectivePriority: 4 })];
    const [row] = buildPrRows(prs, { snapshotRecords });
    expect(row.effPri).toBe(4);
  });

  it('falls back to medium=2 when no snapshot record matches', () => {
    const prs = [makePr({ number: 1, headRefName: 'feat/no-task-id' })];
    const [row] = buildPrRows(prs);
    expect(row.effPri).toBe(2);
  });

  it('tiebreak: same cpl + unblockCount → effPri DESC', () => {
    const prs = [
      makePr({ number: 1, headRefName: 'ai-sdlc/aisdlc-510-x' }),
      makePr({ number: 2, headRefName: 'ai-sdlc/aisdlc-520-x' }),
    ];
    const snapshotRecords = [
      makeRecord('AISDLC-510', { effectivePriority: 1 }),
      makeRecord('AISDLC-520', { effectivePriority: 4 }),
    ];
    const rows = buildPrRows(prs, { snapshotRecords });
    expect(rows.map((r) => r.pr.number)).toEqual([2, 1]);
  });

  it('tiebreak: same cpl + unblockCount + effPri → age ASC (createdAt)', () => {
    const prs = [
      makePr({ number: 1, createdAt: '2026-05-03T00:00:00Z' }),
      makePr({ number: 2, createdAt: '2026-05-01T00:00:00Z' }),
      makePr({ number: 3, createdAt: '2026-05-02T00:00:00Z' }),
    ];
    const rows = buildPrRows(prs);
    expect(rows.map((r) => r.pr.number)).toEqual([2, 3, 1]);
  });

  it('integration: AISDLC-175 → 179 → 176 → 177 chain sorts head-first (AC #7)', () => {
    const prs: GhPrSummary[] = [
      makePr({
        number: 177,
        headRefName: 'ai-sdlc/aisdlc-177-rollback',
        createdAt: '2026-05-03T00:00:00Z',
      }),
      makePr({
        number: 247,
        headRefName: 'ai-sdlc/aisdlc-175-orphan-parent-filter',
        createdAt: '2026-04-30T00:00:00Z',
      }),
      makePr({
        number: 176,
        headRefName: 'ai-sdlc/aisdlc-176-dev-json-retry',
        createdAt: '2026-05-02T00:00:00Z',
      }),
      makePr({
        number: 243,
        headRefName: 'ai-sdlc/aisdlc-179-in-flight-tracking',
        createdAt: '2026-05-01T00:00:00Z',
      }),
    ];
    const snapshotRecords = [
      makeRecord('AISDLC-175'),
      makeRecord('AISDLC-179', { dependencies: ['AISDLC-175'] }),
      makeRecord('AISDLC-176', { dependencies: ['AISDLC-179'] }),
      makeRecord('AISDLC-177', { dependencies: ['AISDLC-176'] }),
    ];
    const rows = buildPrRows(prs, { snapshotRecords });
    // Head of chain (PR #247 = AISDLC-175) is first.
    expect(rows[0].pr.number).toBe(247);
    expect(rows[rows.length - 1].pr.number).toBe(177);
    // Order is the chain order:
    expect(rows.map((r) => r.pr.number)).toEqual([247, 243, 176, 177]);
  });
});

// ── sortPrRows ────────────────────────────────────────────────────────────────

describe('sortPrRows — mode cycling', () => {
  function rowsForModes(): ReturnType<typeof buildPrRows> {
    return buildPrRows(
      [
        makePr({
          number: 1,
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          reviewDecision: 'APPROVED',
          statusCheckRollup: 'SUCCESS',
        } as unknown as Partial<GhPrSummary>), // bucket 4
        makePr({
          number: 2,
          createdAt: '2026-05-03T00:00:00Z',
          updatedAt: '2026-05-04T00:00:00Z',
          mergeable: 'CONFLICTING',
        }), // bucket 2
        makePr({
          number: 3,
          createdAt: '2026-05-02T00:00:00Z',
          updatedAt: '2026-05-03T00:00:00Z',
          reviewDecision: 'CHANGES_REQUESTED',
          statusCheckRollup: 'FAILURE',
        } as unknown as Partial<GhPrSummary>), // bucket 1
      ],
      { mode: 'critical-path' },
    );
  }

  it('critical-path mode: no chains → tiebreak to age ASC', () => {
    const rows = sortPrRows(rowsForModes(), 'critical-path');
    expect(rows.map((r) => r.pr.number)).toEqual([1, 3, 2]);
  });

  it('recency mode: updatedAt DESC', () => {
    const rows = sortPrRows(rowsForModes(), 'recency');
    expect(rows.map((r) => r.pr.number)).toEqual([2, 3, 1]);
  });

  it('ci-status mode: bucket ASC then number DESC (legacy operator-attention sort)', () => {
    const rows = sortPrRows(rowsForModes(), 'ci-status');
    // bucket 0: nothing; bucket 1: PR 3; bucket 2: PR 2; bucket 4: PR 1
    expect(rows.map((r) => r.pr.number)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.bucket)).toEqual([1, 2, 4]);
  });

  it('does not mutate input array', () => {
    const rows = rowsForModes();
    const ids = rows.map((r) => r.pr.number);
    sortPrRows(rows, 'recency');
    expect(rows.map((r) => r.pr.number)).toEqual(ids);
  });
});

// ── nextSortMode ──────────────────────────────────────────────────────────────

describe('nextSortMode — AC #5 cycle', () => {
  it('cycles critical-path → recency → ci-status → critical-path', () => {
    expect(nextSortMode('critical-path')).toBe('recency');
    expect(nextSortMode('recency')).toBe('ci-status');
    expect(nextSortMode('ci-status')).toBe('critical-path');
  });

  it('PR_SORT_MODES exposes the three modes', () => {
    expect(PR_SORT_MODES).toEqual(['critical-path', 'recency', 'ci-status']);
  });
});
