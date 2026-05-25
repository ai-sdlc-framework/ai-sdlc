/**
 * Unit tests for the deprecation lifecycle per RFC-0019 §9.1 OQ-4 re-walkthrough.
 *
 * Covers AISDLC-339 AC#8, AC#9, AC#10:
 *  - Three-layer grace-period precedence (org > adapter > framework)
 *  - Milestone dedup: events emit at 89/60/30/7/1 days, NOT per load
 *  - Removed phase emits migration task auto-action
 *  - Pipeline never halts (no thrown errors at evaluation time)
 */

import { describe, it, expect } from 'vitest';
import {
  resolveGracePeriodDays,
  nextDueMilestone,
  buildDedupKey,
  evaluateDeprecationLifecycle,
  FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS,
  DEPRECATION_MILESTONE_DAYS,
} from './deprecation.js';

/** Build a Date that is N days from the given anchor. */
function daysFrom(anchor: Date, offsetDays: number): Date {
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

describe('resolveGracePeriodDays (three-layer precedence)', () => {
  it('AC#8: returns framework default when both org + adapter overrides are absent', () => {
    expect(resolveGracePeriodDays(undefined, undefined)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
    expect(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS).toBe(90);
  });

  it('AC#8: adapter-declared default overrides framework when org is absent', () => {
    expect(resolveGracePeriodDays(undefined, 60)).toBe(60);
  });

  it('AC#8: per-org override beats adapter-declared default', () => {
    expect(resolveGracePeriodDays(120, 60)).toBe(120);
  });

  it('AC#8: per-org override beats framework default', () => {
    expect(resolveGracePeriodDays(45, undefined)).toBe(45);
  });

  it('AC#8: zero or negative org override falls through to adapter / framework', () => {
    expect(resolveGracePeriodDays(0, 60)).toBe(60);
    expect(resolveGracePeriodDays(-7, undefined)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
  });

  it('AC#8: zero or negative adapter default falls through to framework', () => {
    expect(resolveGracePeriodDays(undefined, 0)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
    expect(resolveGracePeriodDays(undefined, -5)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
  });

  it('AC#8: non-finite values fall through (NaN org, NaN adapter)', () => {
    expect(resolveGracePeriodDays(Number.NaN, undefined)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
    expect(resolveGracePeriodDays(undefined, Number.NaN)).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
  });
});

describe('nextDueMilestone', () => {
  it('returns null when adapter is past deprecatedAt (no milestone "due")', () => {
    expect(nextDueMilestone(-1)).toBeNull();
    expect(nextDueMilestone(-30)).toBeNull();
  });

  it('returns null when adapter is BEFORE the largest milestone (89d)', () => {
    expect(nextDueMilestone(90)).toBeNull();
    expect(nextDueMilestone(120)).toBeNull();
  });

  it('returns 89 when days-to-deprecation is exactly 89 (largest threshold, smallest match)', () => {
    expect(nextDueMilestone(89)).toBe(89);
  });

  it('returns the SMALLEST milestone the caller is at-or-under (most-recently-crossed)', () => {
    // At 75 days, the smallest milestone we are at-or-under is 89 (75 ≤ 89,
    // but 75 > 60 so 60 hasn't been crossed yet).
    expect(nextDueMilestone(75)).toBe(89);
    // At 60 days: 60 ≤ 60 → newly crossed, returns 60.
    expect(nextDueMilestone(60)).toBe(60);
    // At 50 days: still inside the 60-day window (50 ≤ 60 but 50 > 30).
    expect(nextDueMilestone(50)).toBe(60);
    // At 30 days: newly crossed 30.
    expect(nextDueMilestone(30)).toBe(30);
    // At 20 days: still inside 30-day window.
    expect(nextDueMilestone(20)).toBe(30);
    // At 7 days: newly crossed 7.
    expect(nextDueMilestone(7)).toBe(7);
    // At 5 days: still inside 7-day window.
    expect(nextDueMilestone(5)).toBe(7);
    // At 1 day: newly crossed 1.
    expect(nextDueMilestone(1)).toBe(1);
    // At 0 days: still at the 1-day window.
    expect(nextDueMilestone(0)).toBe(1);
  });
});

describe('buildDedupKey', () => {
  it('AC#9: same (type, adapter, deprecatedAt, milestone) → same key', () => {
    const k1 = buildDedupKey(
      'embedding-provider-deprecated',
      'openai-text-embedding-ada-002',
      '2026-06-01',
      30,
    );
    const k2 = buildDedupKey(
      'embedding-provider-deprecated',
      'openai-text-embedding-ada-002',
      '2026-06-01',
      30,
    );
    expect(k1).toBe(k2);
  });

  it('AC#9: different milestones → different keys', () => {
    const k1 = buildDedupKey(
      'embedding-provider-deprecated',
      'openai-text-embedding-ada-002',
      '2026-06-01',
      89,
    );
    const k2 = buildDedupKey(
      'embedding-provider-deprecated',
      'openai-text-embedding-ada-002',
      '2026-06-01',
      30,
    );
    expect(k1).not.toBe(k2);
  });

  it('AC#9: removed event uses null milestone', () => {
    const k = buildDedupKey(
      'embedding-provider-removed',
      'openai-text-embedding-ada-002',
      '2026-06-01',
      null,
    );
    expect(k).toMatch(/^embedding-provider-removed:openai-text-embedding-ada-002:2026-06-01$/);
  });
});

describe('evaluateDeprecationLifecycle', () => {
  // Anchor "today" at a fixed date so tests are deterministic.
  const TODAY = new Date('2026-05-24T00:00:00.000Z');

  it('AC#8: inactive phase when no lifecycle dates declared', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-3-small',
      today: TODAY,
    });
    expect(r.phase).toBe('inactive');
    expect(r.decisionEvents).toEqual([]);
    expect(r.effectiveGracePeriodDays).toBe(FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS);
  });

  it('AC#8: pre-warning phase when today is BEFORE the grace-period window', () => {
    // deprecatedAt is 200 days out; framework default 90d window not yet open.
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 200).toISOString().slice(0, 10),
      today: TODAY,
    });
    expect(r.phase).toBe('pre-warning');
    expect(r.decisionEvents).toEqual([]);
    expect(r.daysToDeprecatedAt).toBeCloseTo(200, 0);
  });

  it('AC#8 + AC#9: warning phase emits milestone event at 89d', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 89).toISOString().slice(0, 10),
      replacementAlias: 'openai-text-embedding-3-small',
      today: TODAY,
    });
    expect(r.phase).toBe('warning');
    expect(r.decisionEvents).toHaveLength(1);
    expect(r.decisionEvents[0]!.milestoneDaysBefore).toBe(89);
    expect(r.decisionEvents[0]!.severity).toBe('info');
    expect(r.decisionEvents[0]!.summary).toContain('openai-text-embedding-3-small');
  });

  it('AC#9: same milestone twice → same dedup key (caller stops second emission)', () => {
    const r1 = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 60).toISOString().slice(0, 10),
      today: TODAY,
    });
    const r2 = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 60).toISOString().slice(0, 10),
      today: TODAY,
    });
    expect(r1.decisionEvents[0]?.dedupKey).toBe(r2.decisionEvents[0]?.dedupKey);
  });

  it('AC#9: different milestones (89 vs 60) → different dedup keys', () => {
    const at89 = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 89).toISOString().slice(0, 10),
      today: TODAY,
    });
    const at60 = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, 60).toISOString().slice(0, 10),
      today: TODAY,
    });
    expect(at89.decisionEvents[0]?.dedupKey).not.toBe(at60.decisionEvents[0]?.dedupKey);
  });

  it('AC#8: deprecated phase (past deprecatedAt, before removedAt) emits info', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, -10).toISOString().slice(0, 10),
      removedAt: daysFrom(TODAY, 60).toISOString().slice(0, 10),
      today: TODAY,
    });
    expect(r.phase).toBe('deprecated');
    expect(r.decisionEvents).toHaveLength(1);
    expect(r.decisionEvents[0]!.severity).toBe('info');
  });

  it('AC#8: deprecated phase in strict mode emits HIGH severity', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, -10).toISOString().slice(0, 10),
      removedAt: daysFrom(TODAY, 60).toISOString().slice(0, 10),
      strictModeAtDeprecatedAt: true,
      today: TODAY,
    });
    expect(r.phase).toBe('deprecated');
    expect(r.decisionEvents[0]!.severity).toBe('high');
  });

  it('AC#10: removed phase emits migration task auto-action + HIGH severity', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'openai-text-embedding-ada-002',
      deprecatedAt: daysFrom(TODAY, -60).toISOString().slice(0, 10),
      removedAt: daysFrom(TODAY, -1).toISOString().slice(0, 10),
      replacementAlias: 'openai-text-embedding-3-small',
      today: TODAY,
    });
    expect(r.phase).toBe('removed');
    expect(r.decisionEvents).toHaveLength(1);
    expect(r.decisionEvents[0]!.decisionType).toBe('embedding-provider-removed');
    expect(r.decisionEvents[0]!.severity).toBe('high');
    expect(r.decisionEvents[0]!.autoAction).toBe('emit-migration-task');
    expect(r.decisionEvents[0]!.summary).toContain('openai-text-embedding-3-small');
  });

  it('AC#10: pipeline NEVER halts — evaluateDeprecationLifecycle does not throw on removed', () => {
    expect(() =>
      evaluateDeprecationLifecycle({
        adapterName: 'openai-text-embedding-ada-002',
        removedAt: daysFrom(TODAY, -100).toISOString().slice(0, 10),
        today: TODAY,
      }),
    ).not.toThrow();
  });

  it('AC#8: adapter-declared 60d grace narrows the window vs framework 90d', () => {
    // At 75 days before deprecatedAt with adapterDefaultGracePeriodDays=60,
    // we are BEFORE the warning window → pre-warning.
    const r = evaluateDeprecationLifecycle({
      adapterName: 'cohere-embed-v3',
      deprecatedAt: daysFrom(TODAY, 75).toISOString().slice(0, 10),
      adapterDefaultGracePeriodDays: 60,
      today: TODAY,
    });
    expect(r.effectiveGracePeriodDays).toBe(60);
    expect(r.phase).toBe('pre-warning');
  });

  it('AC#8: org override 120d widens the window vs adapter 60d', () => {
    const r = evaluateDeprecationLifecycle({
      adapterName: 'cohere-embed-v3',
      deprecatedAt: daysFrom(TODAY, 100).toISOString().slice(0, 10),
      adapterDefaultGracePeriodDays: 60,
      orgGracePeriodDays: 120,
      today: TODAY,
    });
    expect(r.effectiveGracePeriodDays).toBe(120);
    // 100 days out with 120-day window → in warning window.
    expect(r.phase).toBe('warning');
  });

  it('AC#9: milestone constants are in descending order (largest first)', () => {
    const sorted = [...DEPRECATION_MILESTONE_DAYS].sort((a, b) => b - a);
    expect([...DEPRECATION_MILESTONE_DAYS]).toEqual(sorted);
    expect(DEPRECATION_MILESTONE_DAYS).toEqual([89, 60, 30, 7, 1]);
  });

  it('AC#8: warning phase inside the window but BEFORE largest milestone emits no event', () => {
    // deprecatedAt is 100 days out, org window is 120 days → in warning phase
    // but daysToDeprecatedAt=100 > 89 milestone, so no milestone is "due".
    const r = evaluateDeprecationLifecycle({
      adapterName: 'cohere-embed-v3',
      deprecatedAt: daysFrom(TODAY, 100).toISOString().slice(0, 10),
      orgGracePeriodDays: 120,
      today: TODAY,
    });
    expect(r.phase).toBe('warning');
    expect(r.decisionEvents).toEqual([]);
  });
});
