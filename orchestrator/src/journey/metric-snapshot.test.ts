/**
 * RFC-0018 Phase 4 — MetricSnapshot + Eρ₅ degradation hermetic tests.
 *
 * Covers acceptance criteria:
 *   AC #2: MetricSnapshot read API (getLatestMetricSnapshot)
 *   AC #3: Stale-metric detection + Decision: journey-metric-stale + warn-and-unknown behavior
 *   AC #4: Graduated Eρ₅ degradation (0/30/60/90 thresholds + correct Decisions)
 *   AC #5: Per-Soul policy overrides: binary-30d + hard-block modes
 *   AC #6: RFC-0022 multi-posture composition (strictest cadence + grace policy applies)
 *   AC #8: Hermetic tests: round-trip, stale detection, graduated thresholds, per-Soul overrides
 *
 * Test groups:
 *   1. MetricSnapshot round-trip (write, read, query latest)
 *   2. Stale-metric detection: threshold boundaries; Decision emission; Cκ warn-and-unknown
 *   3. Graduated Eρ₅ degradation: each threshold (0/30/60/90) emits correct Decision + impact
 *   4. Per-Soul override: binary-30d and hard-block modes
 *   5. Multi-posture composition with RFC-0022 (strictest cadence + policy applies)
 */

import { describe, it, expect } from 'vitest';

import {
  getLatestMetricSnapshot,
  computeAuditOverdueErho5,
  resolveStrictestCadence,
  resolveStrictestGracePolicy,
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  DEFAULT_GRADUATED_THRESHOLDS,
  ERHO5_MULTIPLIERS,
  AUDIT_CADENCE_STRICTNESS,
  GRACE_POLICY_STRICTNESS,
  type MetricSnapshot,
  type AuditCadence,
  type AuditOverdueGracePolicy,
} from './metric-snapshot.js';

// ── Fixture helpers ────────────────────────────────────────────────────

const NOW = '2026-06-01T00:00:00.000Z';
const nowMs = new Date(NOW).getTime();

function daysAgo(days: number): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeSnapshot(
  journey: string,
  metricId: string,
  value: number,
  recordedAt: string,
  sourceTool = 'mixpanel',
): MetricSnapshot {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'MetricSnapshot',
    metadata: { journey, metricId },
    spec: { value, recordedAt, sourceTool },
  };
}

// ── 1. MetricSnapshot round-trip ──────────────────────────────────────

describe('getLatestMetricSnapshot — round-trip', () => {
  it('returns missing when no snapshots exist', () => {
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots: [],
      now: NOW,
    });
    expect(result.freshness).toBe('missing');
    expect(result.snapshot).toBeUndefined();
    expect(result.decision).toBeUndefined();
    expect(result.thresholdDays).toBe(DEFAULT_STALENESS_THRESHOLD_DAYS);
  });

  it('returns missing when no snapshot matches the journey', () => {
    const snapshots = [
      makeSnapshot('other-soul/other-journey', 'completion-rate', 0.7, daysAgo(5)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('missing');
  });

  it('returns missing when no snapshot matches the metricId', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'median-time-to-done', 1200, daysAgo(5)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('missing');
  });

  it('returns fresh when snapshot is within threshold', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(10)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('fresh');
    expect(result.snapshot?.spec.value).toBe(0.65);
    expect(result.decision).toBeUndefined();
    expect(result.ageInDays).toBeCloseTo(10, 0);
  });

  it('selects the latest snapshot when multiple exist for same journey+metricId', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.55, daysAgo(20)),
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(5)), // latest
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.6, daysAgo(12)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('fresh');
    expect(result.snapshot?.spec.value).toBe(0.65); // latest wins
  });

  it('handles variant-scoped journey URI', () => {
    const snapshots = [
      makeSnapshot('spry-engage/annual-test/submit-results', 'completion-rate', 0.9, daysAgo(5)),
    ];
    const result = getLatestMetricSnapshot(
      'spry-engage/annual-test/submit-results',
      'completion-rate',
      { snapshots, now: NOW },
    );
    expect(result.freshness).toBe('fresh');
    expect(result.snapshot?.spec.value).toBe(0.9);
  });
});

// ── 2. Stale-metric detection ─────────────────────────────────────────

describe('getLatestMetricSnapshot — stale-metric detection', () => {
  it('returns fresh at exactly threshold boundary (threshold = 30)', () => {
    // Age exactly equal to threshold is NOT stale (> threshold, not >=)
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(30)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('fresh');
    expect(result.decision).toBeUndefined();
  });

  it('returns stale just past threshold (30.01 days)', () => {
    // 30 days + 1 minute past threshold = stale
    const justPastThreshold = new Date(nowMs - (30 * 24 * 60 + 1) * 60 * 1000).toISOString();
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, justPastThreshold),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('stale');
    expect(result.decision).toBe('journey-metric-stale');
    expect(result.snapshot).toBeDefined();
  });

  it('emits Decision: journey-metric-stale for stale snapshot', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(45)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('stale');
    expect(result.decision).toBe('journey-metric-stale');
    // Cκ warn-and-unknown: snapshot is still returned (warn, not fail-closed)
    expect(result.snapshot?.spec.value).toBe(0.65);
    expect(result.ageInDays).toBeGreaterThan(30);
  });

  it('respects per-Soul staleness threshold override (thresholdDays=7)', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(10)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      stalenessConfig: { thresholdDays: 7 },
      now: NOW,
    });
    expect(result.freshness).toBe('stale');
    expect(result.decision).toBe('journey-metric-stale');
    expect(result.thresholdDays).toBe(7);
  });

  it('respects per-Soul staleness threshold override (thresholdDays=90)', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.65, daysAgo(60)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      stalenessConfig: { thresholdDays: 90 },
      now: NOW,
    });
    expect(result.freshness).toBe('fresh');
    expect(result.decision).toBeUndefined();
    expect(result.thresholdDays).toBe(90);
  });

  it('warn-and-unknown: stale result still includes snapshot value (not fail-closed)', () => {
    const snapshots = [
      makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.42, daysAgo(60)),
    ];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    // Cκ pipeline: warn-and-unknown means decision routes to batch review,
    // but the pipeline does NOT fail closed — snapshot value is still accessible.
    expect(result.freshness).toBe('stale');
    expect(result.snapshot?.spec.value).toBe(0.42);
    expect(result.decision).toBe('journey-metric-stale');
  });
});

// ── 3. Graduated Eρ₅ degradation ─────────────────────────────────────

describe('computeAuditOverdueErho5 — graduated policy', () => {
  const soul = 'spry-engage';
  const journey = 'onboarding';

  it('returns warn at daysOverdue=0 (cadence+0d fires graduated warn, no grace)', () => {
    // daysOverdue=0 means exactly at the cadence boundary. The graduated policy
    // warnAt threshold defaults to 0, so a warn Decision is emitted at day 0.
    // (The early-exit only catches daysOverdue < 0 — truly not-yet-due audits.)
    const result = computeAuditOverdueErho5({ soulId: soul, journeyId: journey, daysOverdue: 0 });
    expect(result.impact).toBe('warn');
    expect(result.erho5Multiplier).toBe(1.0);
    expect(result.decision).toBe('journey-audit-overdue-warn');
  });

  it('returns no impact when audit is negative days overdue (not yet due)', () => {
    const result = computeAuditOverdueErho5({ soulId: soul, journeyId: journey, daysOverdue: -10 });
    expect(result.erho5Multiplier).toBe(1.0);
    expect(result.decision).toBeNull();
  });

  it('0-30d range: emits journey-audit-overdue-warn, multiplier 1.0', () => {
    for (const days of [1, 15, 29]) {
      const result = computeAuditOverdueErho5({
        soulId: soul,
        journeyId: journey,
        daysOverdue: days,
        policy: 'graduated',
      });
      expect(result.impact).toBe('warn');
      expect(result.erho5Multiplier).toBe(1.0);
      expect(result.decision).toBe('journey-audit-overdue-warn');
    }
  });

  it('30-60d range: emits journey-audit-overdue-graduated, multiplier 0.75 (-25%)', () => {
    for (const days of [30, 45, 59]) {
      const result = computeAuditOverdueErho5({
        soulId: soul,
        journeyId: journey,
        daysOverdue: days,
        policy: 'graduated',
      });
      expect(result.impact).toBe('reduced-25');
      expect(result.erho5Multiplier).toBe(ERHO5_MULTIPLIERS['reduced-25']);
      expect(result.decision).toBe('journey-audit-overdue-graduated');
    }
  });

  it('60-90d range: emits journey-audit-overdue-graduated, multiplier 0.50 (-50%)', () => {
    for (const days of [60, 75, 89]) {
      const result = computeAuditOverdueErho5({
        soulId: soul,
        journeyId: journey,
        daysOverdue: days,
        policy: 'graduated',
      });
      expect(result.impact).toBe('reduced-50');
      expect(result.erho5Multiplier).toBe(ERHO5_MULTIPLIERS['reduced-50']);
      expect(result.decision).toBe('journey-audit-overdue-graduated');
    }
  });

  it('90d+ range: emits journey-audit-overdue-blocking, multiplier 0.0 (effective block)', () => {
    for (const days of [90, 120, 365]) {
      const result = computeAuditOverdueErho5({
        soulId: soul,
        journeyId: journey,
        daysOverdue: days,
        policy: 'graduated',
      });
      expect(result.impact).toBe('effective-block');
      expect(result.erho5Multiplier).toBe(0.0);
      expect(result.decision).toBe('journey-audit-overdue-blocking');
    }
  });

  it('respects custom graduated thresholds', () => {
    const custom = { warnAt: 0, reduced25At: 7, reduced50At: 14, effectiveBlockAt: 21 };

    // At 10 days with custom thresholds: should be in reduced-25 range (7-14)
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 10,
      policy: 'graduated',
      graduatedThresholds: custom,
    });
    expect(result.impact).toBe('reduced-25');
    expect(result.decision).toBe('journey-audit-overdue-graduated');
  });

  it('uses default graduated thresholds when none provided', () => {
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 45,
    });
    // Default thresholds: reduced25At=30, reduced50At=60
    expect(result.impact).toBe('reduced-25');
    expect(result.erho5Multiplier).toBe(0.75);
  });

  it('includes soulId and journeyId in the result', () => {
    const result = computeAuditOverdueErho5({
      soulId: 'my-soul',
      journeyId: 'my-journey',
      daysOverdue: 45,
    });
    expect(result.soulId).toBe('my-soul');
    expect(result.journeyId).toBe('my-journey');
    expect(result.daysOverdue).toBe(45);
  });
});

// ── 4. Per-Soul override: binary-30d and hard-block ───────────────────

describe('computeAuditOverdueErho5 — binary-30d policy', () => {
  const soul = 'hipaa-shop';
  const journey = 'patient-portal-onboarding';

  it('within grace window (< 30d): warn only, no Eρ₅ impact', () => {
    for (const days of [1, 15, 29]) {
      const result = computeAuditOverdueErho5({
        soulId: soul,
        journeyId: journey,
        daysOverdue: days,
        policy: 'binary-30d',
      });
      expect(result.impact).toBe('warn');
      expect(result.erho5Multiplier).toBe(1.0);
      expect(result.decision).toBe('journey-audit-overdue-warn');
    }
  });

  it('at 30d: immediate effective-block', () => {
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 30,
      policy: 'binary-30d',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });

  it('past 30d: still effective-block', () => {
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 90,
      policy: 'binary-30d',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });
});

describe('computeAuditOverdueErho5 — hard-block policy', () => {
  const soul = 'pci-shop';
  const journey = 'payment-checkout';

  it('fires effective-block at daysOverdue=0 (cadence+0d, no grace)', () => {
    // hard-block design: "Immediate Eρ₅ fail at cadence+0d (strictest, no grace)".
    // daysOverdue=0 means exactly at the cadence boundary → effective-block.
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 0,
      policy: 'hard-block',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });

  it('even 1 day overdue: immediate effective-block', () => {
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 1,
      policy: 'hard-block',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });

  it('50 days overdue: effective-block', () => {
    const result = computeAuditOverdueErho5({
      soulId: soul,
      journeyId: journey,
      daysOverdue: 50,
      policy: 'hard-block',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });
});

// ── 5. RFC-0022 multi-posture composition ──────────────────────────────

describe('resolveStrictestCadence — RFC-0022 multi-posture composition', () => {
  it('returns journey cadence when no posture constraints', () => {
    const result = resolveStrictestCadence({
      journeyCadence: 'annually',
      postureCadences: [],
    });
    expect(result).toBe('annually');
  });

  it('posture beats journey when posture is stricter', () => {
    const result = resolveStrictestCadence({
      journeyCadence: 'annually',
      postureCadences: ['quarterly'],
    });
    expect(result).toBe('quarterly');
  });

  it('journey beats posture when journey is stricter', () => {
    const result = resolveStrictestCadence({
      journeyCadence: 'continuous',
      postureCadences: ['quarterly', 'annually'],
    });
    expect(result).toBe('continuous');
  });

  it('multiple postures: picks the strictest among all', () => {
    const result = resolveStrictestCadence({
      journeyCadence: 'annually',
      postureCadences: ['quarterly', 'release-gated', 'annually'],
    });
    expect(result).toBe('release-gated');
  });

  it('strictness ordering is correct', () => {
    const cadences: AuditCadence[] = ['annually', 'quarterly', 'release-gated', 'continuous'];
    const strictnesses = cadences.map((c) => AUDIT_CADENCE_STRICTNESS[c]);
    for (let i = 1; i < strictnesses.length; i++) {
      expect(strictnesses[i]).toBeGreaterThan(strictnesses[i - 1]);
    }
  });
});

describe('resolveStrictestGracePolicy — RFC-0022 multi-posture composition', () => {
  it('returns soul policy when no posture constraints', () => {
    const result = resolveStrictestGracePolicy({
      soulPolicy: 'graduated',
      posturesPolicies: [],
    });
    expect(result).toBe('graduated');
  });

  it('uses default graduated when no soulPolicy provided', () => {
    const result = resolveStrictestGracePolicy({
      posturesPolicies: [],
    });
    expect(result).toBe('graduated');
  });

  it('posture beats soul when posture is stricter', () => {
    const result = resolveStrictestGracePolicy({
      soulPolicy: 'graduated',
      posturesPolicies: ['binary-30d'],
    });
    expect(result).toBe('binary-30d');
  });

  it('soul beats posture when soul is stricter', () => {
    const result = resolveStrictestGracePolicy({
      soulPolicy: 'hard-block',
      posturesPolicies: ['graduated', 'binary-30d'],
    });
    expect(result).toBe('hard-block');
  });

  it('multiple postures: picks the strictest', () => {
    const result = resolveStrictestGracePolicy({
      soulPolicy: 'graduated',
      posturesPolicies: ['binary-30d', 'hard-block', 'graduated'],
    });
    expect(result).toBe('hard-block');
  });

  it('strictness ordering: graduated < binary-30d < hard-block', () => {
    const policies: AuditOverdueGracePolicy[] = ['graduated', 'binary-30d', 'hard-block'];
    const strictnesses = policies.map((p) => GRACE_POLICY_STRICTNESS[p]);
    for (let i = 1; i < strictnesses.length; i++) {
      expect(strictnesses[i]).toBeGreaterThan(strictnesses[i - 1]);
    }
  });

  it('SOC2 posture promotes graduated → binary-30d, then compute still produces correct result', () => {
    // Simulate: soul has graduated, SOC2 compliance posture requires binary-30d
    const effectivePolicy = resolveStrictestGracePolicy({
      soulPolicy: 'graduated',
      posturesPolicies: ['binary-30d'],
    });
    expect(effectivePolicy).toBe('binary-30d');

    // At 45d with binary-30d: should be effective-block (not reduced-25 as graduated would give)
    const erho5 = computeAuditOverdueErho5({
      soulId: 'my-soul',
      journeyId: 'my-journey',
      daysOverdue: 45,
      policy: effectivePolicy,
    });
    expect(erho5.impact).toBe('effective-block');
    expect(erho5.erho5Multiplier).toBe(0.0);
  });
});

// ── Future-dated recordedAt guard ─────────────────────────────────────

describe('getLatestMetricSnapshot — future-dated recordedAt guard', () => {
  it('treats future-dated recordedAt as stale (clamps negative age)', () => {
    // A snapshot with recordedAt in the future would yield negative ageInDays,
    // making it appear perpetually fresh. The guard clamps this to stale.
    const futureDate = new Date(new Date(NOW).getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const snapshots = [makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.99, futureDate)];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('stale');
    expect(result.decision).toBe('journey-metric-stale');
  });

  it('treats present-day recordedAt (equal to now) as fresh (age=0, within threshold)', () => {
    const snapshots = [makeSnapshot('spry-engage/onboarding', 'completion-rate', 0.5, NOW)];
    const result = getLatestMetricSnapshot('spry-engage/onboarding', 'completion-rate', {
      snapshots,
      now: NOW,
    });
    expect(result.freshness).toBe('fresh');
    expect(result.decision).toBeUndefined();
  });
});

// ── NaN guard in graduated path ────────────────────────────────────────

describe('computeAuditOverdueErho5 — NaN / non-finite guard', () => {
  it('treats NaN daysOverdue as effective-block (fail-closed, not fail-open)', () => {
    const result = computeAuditOverdueErho5({
      soulId: 'test-soul',
      journeyId: 'test-journey',
      daysOverdue: NaN,
      policy: 'graduated',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });

  it('treats Infinity daysOverdue as effective-block', () => {
    const result = computeAuditOverdueErho5({
      soulId: 'test-soul',
      journeyId: 'test-journey',
      daysOverdue: Infinity,
      policy: 'graduated',
    });
    expect(result.impact).toBe('effective-block');
    expect(result.erho5Multiplier).toBe(0.0);
    expect(result.decision).toBe('journey-audit-overdue-blocking');
  });
});

// ── Truly-negative daysOverdue (not-yet-due) ──────────────────────────

describe('computeAuditOverdueErho5 — strictly negative (not-yet-due)', () => {
  it('returns null decision for daysOverdue=-1 (audit not yet due)', () => {
    const result = computeAuditOverdueErho5({
      soulId: 'test-soul',
      journeyId: 'test-journey',
      daysOverdue: -1,
      policy: 'graduated',
    });
    expect(result.erho5Multiplier).toBe(1.0);
    expect(result.decision).toBeNull();
  });

  it('returns null decision for daysOverdue=-10 with hard-block policy', () => {
    const result = computeAuditOverdueErho5({
      soulId: 'test-soul',
      journeyId: 'test-journey',
      daysOverdue: -10,
      policy: 'hard-block',
    });
    expect(result.erho5Multiplier).toBe(1.0);
    expect(result.decision).toBeNull();
  });
});

// ── Constants and exports sanity checks ───────────────────────────────

describe('exported constants', () => {
  it('DEFAULT_STALENESS_THRESHOLD_DAYS is 30', () => {
    expect(DEFAULT_STALENESS_THRESHOLD_DAYS).toBe(30);
  });

  it('DEFAULT_GRADUATED_THRESHOLDS matches RFC-0018 §10.1 OQ-6 values', () => {
    expect(DEFAULT_GRADUATED_THRESHOLDS.warnAt).toBe(0);
    expect(DEFAULT_GRADUATED_THRESHOLDS.reduced25At).toBe(30);
    expect(DEFAULT_GRADUATED_THRESHOLDS.reduced50At).toBe(60);
    expect(DEFAULT_GRADUATED_THRESHOLDS.effectiveBlockAt).toBe(90);
  });

  it('ERHO5_MULTIPLIERS values match design', () => {
    expect(ERHO5_MULTIPLIERS['warn']).toBe(1.0);
    expect(ERHO5_MULTIPLIERS['reduced-25']).toBe(0.75);
    expect(ERHO5_MULTIPLIERS['reduced-50']).toBe(0.5);
    expect(ERHO5_MULTIPLIERS['effective-block']).toBe(0.0);
  });
});

// Note: AJV schema round-trip tests for metric-snapshot.v1.schema.json live in
// reference/src/core/metric-snapshot-schema.test.ts — AJV is a dependency of
// @ai-sdlc/reference, not @ai-sdlc/orchestrator. The round-trip tests there
// cover: accept well-formed, reject missing-required, reject wrong apiVersion const,
// reject metricId pattern violations, and reject unknown properties.
