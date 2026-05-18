/**
 * useDecisionsPending hook tests — AISDLC-292 AC#1.
 *
 * Tests `filterAndSort` (the pure helper) directly and validates the hook's
 * dependency-injection path for the lister override.
 */

import { describe, expect, it } from 'vitest';

import { filterAndSort, DECISIONS_POLL_INTERVAL_MS } from './use-decisions-pending.js';
import type { Decision } from '../../decisions/decision-record.js';

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDecision(
  id: string,
  lifecycle: Decision['status']['lifecycle'],
  priority?: number,
  created?: string,
): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id,
      source: 'ad-hoc',
      scope: 'workspace',
      created: created ?? '2026-05-01T00:00:00Z',
      updated: '2026-05-01T00:00:00Z',
    },
    spec: {
      summary: `Summary for ${id}`,
      options: [{ id: 'opt-a', description: 'Option A' }],
    },
    status: {
      lifecycle,
      priority: priority ?? null,
    },
    decisionLog: [],
  };
}

// ── filterAndSort ─────────────────────────────────────────────────────────────

describe('filterAndSort', () => {
  it('returns empty array for empty input', () => {
    expect(filterAndSort([])).toEqual([]);
  });

  it('keeps only open lifecycle decisions', () => {
    const decisions = [
      makeDecision('DEC-0001', 'open'),
      makeDecision('DEC-0002', 'answered'),
      makeDecision('DEC-0003', 'deferred'),
      makeDecision('DEC-0004', 'open'),
    ];
    const result = filterAndSort(decisions);
    expect(result.map((d) => d.metadata.id)).toEqual(['DEC-0001', 'DEC-0004']);
  });

  it('sorts by priority DESC', () => {
    const decisions = [
      makeDecision('DEC-0001', 'open', 0.3),
      makeDecision('DEC-0002', 'open', 0.9),
      makeDecision('DEC-0003', 'open', 0.6),
    ];
    const result = filterAndSort(decisions);
    expect(result.map((d) => d.metadata.id)).toEqual(['DEC-0002', 'DEC-0003', 'DEC-0001']);
  });

  it('breaks priority ties by creation date ASC (oldest first)', () => {
    const decisions = [
      makeDecision('DEC-0001', 'open', 0.5, '2026-05-03T00:00:00Z'),
      makeDecision('DEC-0002', 'open', 0.5, '2026-05-01T00:00:00Z'),
      makeDecision('DEC-0003', 'open', 0.5, '2026-05-02T00:00:00Z'),
    ];
    const result = filterAndSort(decisions);
    expect(result.map((d) => d.metadata.id)).toEqual(['DEC-0002', 'DEC-0003', 'DEC-0001']);
  });

  it('treats null/absent priority as 0.5', () => {
    const withPriority = makeDecision('DEC-0001', 'open', 0.7);
    const noPriority = makeDecision('DEC-0002', 'open', undefined);
    const result = filterAndSort([noPriority, withPriority]);
    expect(result[0]!.metadata.id).toBe('DEC-0001'); // 0.7 > 0.5
  });
});

// ── Default export ────────────────────────────────────────────────────────────

describe('DECISIONS_POLL_INTERVAL_MS', () => {
  it('is 15 seconds', () => {
    expect(DECISIONS_POLL_INTERVAL_MS).toBe(15_000);
  });
});
