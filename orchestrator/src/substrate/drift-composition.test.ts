/**
 * Hermetic tests for the RFC-0028 §7.2 drift composition module (AC-7).
 *
 * Coverage:
 *   - Composition: structural drift BLOCKS while statistical drift does NOT
 *     halt the pipeline (rules 1 + 2).
 *   - Cold-start: pre-30d-baseline emits "calibrating", no statistical
 *     Decisions (rule 4 / AC-4).
 *   - Catalog correlation: both classes for one Soul are queryable
 *     side-by-side (rule 3 / AC-3).
 *   - Reconciliation paths: exactly three for statistical drift
 *     (confirm-as-evolution, confirm-as-violation, defer) (AC-6).
 *   - Decision requests reuse the RFC-0035 catalog shape — no parallel
 *     emitter (AC-8).
 */

import { describe, it, expect } from 'vitest';
import {
  DRIFT_DECISION_SCOPE,
  STRUCTURAL_DECISION_SLUG,
  STATISTICAL_DECISION_SLUG,
  MEAN_FLOOR,
  STDDEV_CEILING,
  SUSTAINED_SPRINTS,
  BASELINE_WINDOW_DAYS,
  STATISTICAL_RECONCILIATION_OPTIONS,
  STRUCTURAL_RECONCILIATION_OPTIONS,
  toStructuralDriftEvents,
  evaluateStatisticalDrift,
  toStatisticalDriftEvent,
  toDecisionRequest,
  composeDrift,
  correlateDriftBySoul,
  type StructuralGateResult,
  type SoulDriftSample,
  type DriftEvent,
} from './drift-composition.js';

const NOW = new Date('2026-05-30T00:00:00.000Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** A baseline-complete, in-bounds, healthy series (≥30d span). */
function healthySeries(): SoulDriftSample[] {
  return [
    { at: daysAgo(40), value: 0.8 },
    { at: daysAgo(30), value: 0.82 },
    { at: daysAgo(20), value: 0.79 },
    { at: daysAgo(10), value: 0.81 },
    { at: daysAgo(1), value: 0.8 },
  ];
}

describe('structural layer (rule 1 — REJECTS deployment)', () => {
  it('passes → no drift events, not blocked', () => {
    const result: StructuralGateResult = { passed: true, coldStart: false, failures: [] };
    expect(toStructuralDriftEvents(result)).toEqual([]);
  });

  it('cold-start (no contracts) → no drift events', () => {
    const result: StructuralGateResult = { passed: true, coldStart: true, failures: [] };
    expect(toStructuralDriftEvents(result)).toEqual([]);
  });

  it('failure → one HIGH, blocking event per failure', () => {
    const result: StructuralGateResult = {
      passed: false,
      coldStart: false,
      failures: [
        { soulId: 'soul-a', message: 'phantom-Soul DID', decisionSummary: 'pre-formatted' },
        { soulId: 'soul-b', message: 'director not in council' },
      ],
    };
    const events = toStructuralDriftEvents(result);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      driftClass: 'structural',
      soulId: 'soul-a',
      severity: 'high',
      blocking: true,
      summary: 'pre-formatted',
    });
    // Falls back to a generated summary when the gate didn't supply one.
    expect(events[1].summary).toContain(STRUCTURAL_DECISION_SLUG);
    expect(events[1].summary).toContain('soul-b');
  });
});

describe('statistical layer cold-start (rule 4 / AC-4)', () => {
  it('empty series → calibrating, no drift, null stats', () => {
    const r = evaluateStatisticalDrift([], undefined, NOW);
    expect(r.status).toBe('calibrating');
    expect(r.drifted).toBe(false);
    expect(r.rollingMean).toBeNull();
    expect(r.rollingStdDev).toBeNull();
  });

  it('< 30d of signal → calibrating, no statistical Decision emitted', () => {
    const samples: SoulDriftSample[] = [
      { at: daysAgo(10), value: 0.2 }, // would breach mean floor IF active
      { at: daysAgo(5), value: 0.1 },
      { at: daysAgo(1), value: 0.15 },
    ];
    const r = evaluateStatisticalDrift(samples, [true, true, true], NOW);
    expect(r.status).toBe('calibrating');
    expect(r.drifted).toBe(false);
    // No event surfaced → caller emits no Decision during calibration.
    expect(toStatisticalDriftEvent('soul-x', r)).toBeNull();
  });

  it('cold-start window boundary uses BASELINE_WINDOW_DAYS = 30', () => {
    expect(BASELINE_WINDOW_DAYS).toBe(30);
  });
});

describe('statistical layer active detection (rule 2)', () => {
  it('healthy active series → active, not drifted', () => {
    const r = evaluateStatisticalDrift(healthySeries(), [false, false, false], NOW);
    expect(r.status).toBe('active');
    expect(r.drifted).toBe(false);
    expect(r.rollingMean).not.toBeNull();
  });

  it('mean below floor sustained 3 sprints → drifted', () => {
    const samples: SoulDriftSample[] = [
      { at: daysAgo(40), value: 0.3 },
      { at: daysAgo(25), value: 0.25 },
      { at: daysAgo(15), value: 0.2 },
      { at: daysAgo(5), value: 0.35 },
    ];
    const r = evaluateStatisticalDrift(samples, [true, true, true], NOW);
    expect(r.status).toBe('active');
    expect(r.rollingMean).toBeLessThan(MEAN_FLOOR);
    expect(r.sustainedSprints).toBe(SUSTAINED_SPRINTS);
    expect(r.drifted).toBe(true);
  });

  it('stddev above ceiling sustained 3 sprints → drifted', () => {
    const samples: SoulDriftSample[] = [
      { at: daysAgo(40), value: 0.95 },
      { at: daysAgo(25), value: 0.5 },
      { at: daysAgo(15), value: 0.95 },
      { at: daysAgo(5), value: 0.45 },
    ];
    const r = evaluateStatisticalDrift(samples, [true, true, true], NOW);
    expect(r.status).toBe('active');
    expect(r.rollingStdDev).toBeGreaterThan(STDDEV_CEILING);
    expect(r.drifted).toBe(true);
  });

  it('breach but only 2 sustained sprints → NOT drifted', () => {
    const samples: SoulDriftSample[] = [
      { at: daysAgo(40), value: 0.3 },
      { at: daysAgo(5), value: 0.2 },
    ];
    const r = evaluateStatisticalDrift(samples, [false, true, true], NOW);
    expect(r.status).toBe('active');
    expect(r.sustainedSprints).toBe(2);
    expect(r.drifted).toBe(false);
    expect(toStatisticalDriftEvent('soul-x', r)).toBeNull();
  });

  it('drifted active result → advisory, non-blocking event', () => {
    const samples: SoulDriftSample[] = [
      { at: daysAgo(40), value: 0.3 },
      { at: daysAgo(25), value: 0.25 },
      { at: daysAgo(15), value: 0.2 },
    ];
    const r = evaluateStatisticalDrift(samples, [true, true, true], NOW);
    const evt = toStatisticalDriftEvent('soul-x', r);
    expect(evt).not.toBeNull();
    expect(evt).toMatchObject({
      driftClass: 'statistical',
      soulId: 'soul-x',
      severity: 'advisory',
      blocking: false,
    });
    expect(evt?.summary).toContain(STATISTICAL_DECISION_SLUG);
  });
});

describe('composition (rule 1 + 2): structural blocks, statistical does not halt', () => {
  it('structural failure blocks; concurrent statistical drift surfaces but does not add to blocked', () => {
    const structural: StructuralGateResult = {
      passed: false,
      coldStart: false,
      failures: [{ soulId: 'soul-a', message: 'phantom-Soul DID' }],
    };
    const driftedStat = evaluateStatisticalDrift(
      [
        { at: daysAgo(40), value: 0.3 },
        { at: daysAgo(25), value: 0.25 },
        { at: daysAgo(15), value: 0.2 },
      ],
      [true, true, true],
      NOW,
    );
    const composed = composeDrift(structural, [{ soulId: 'soul-b', result: driftedStat }]);
    expect(composed.blocked).toBe(true); // structural is the hard gate
    expect(composed.events).toHaveLength(2);
    expect(composed.events.filter((e) => e.driftClass === 'structural')).toHaveLength(1);
    expect(composed.events.filter((e) => e.driftClass === 'statistical')).toHaveLength(1);
  });

  it('only statistical drift → NOT blocked (pipeline never halts on statistical)', () => {
    const structural: StructuralGateResult = { passed: true, coldStart: false, failures: [] };
    const driftedStat = evaluateStatisticalDrift(
      [
        { at: daysAgo(40), value: 0.3 },
        { at: daysAgo(25), value: 0.25 },
        { at: daysAgo(15), value: 0.2 },
      ],
      [true, true, true],
      NOW,
    );
    const composed = composeDrift(structural, [{ soulId: 'soul-b', result: driftedStat }]);
    expect(composed.blocked).toBe(false);
    expect(composed.events).toHaveLength(1);
    expect(composed.events[0].driftClass).toBe('statistical');
  });

  it('calibrating statistical results contribute no events (AC-4)', () => {
    const structural: StructuralGateResult = { passed: true, coldStart: false, failures: [] };
    const calibrating = evaluateStatisticalDrift([{ at: daysAgo(5), value: 0.1 }], undefined, NOW);
    const composed = composeDrift(structural, [{ soulId: 'soul-b', result: calibrating }]);
    expect(composed.events).toHaveLength(0);
    expect(composed.requests).toHaveLength(0);
    expect(composed.blocked).toBe(false);
  });
});

describe('catalog correlation (rule 3 / AC-3 + AC-5)', () => {
  it('groups both drift classes for one Soul side-by-side', () => {
    const events: DriftEvent[] = [
      {
        driftClass: 'structural',
        soulId: 'soul-a',
        severity: 'high',
        blocking: true,
        summary: 'structural for a',
      },
      {
        driftClass: 'statistical',
        soulId: 'soul-a',
        severity: 'advisory',
        blocking: false,
        summary: 'statistical for a',
      },
      {
        driftClass: 'statistical',
        soulId: 'soul-b',
        severity: 'advisory',
        blocking: false,
        summary: 'statistical for b',
      },
    ];
    const bySoul = correlateDriftBySoul(events);
    expect([...bySoul.keys()]).toEqual(['soul-a', 'soul-b']);
    expect(bySoul.get('soul-a')).toHaveLength(2);
    expect(bySoul.get('soul-a')?.map((e) => e.driftClass)).toEqual(['structural', 'statistical']);
    expect(bySoul.get('soul-b')).toHaveLength(1);
  });
});

describe('reconciliation paths (AC-6) — exactly three for statistical', () => {
  it('statistical has exactly the three RFC-0028 §7.2 paths', () => {
    expect(STATISTICAL_RECONCILIATION_OPTIONS).toHaveLength(3);
    expect(STATISTICAL_RECONCILIATION_OPTIONS.map((o) => o.id)).toEqual([
      'confirm-as-evolution',
      'confirm-as-violation',
      'defer',
    ]);
  });

  it('structural mirrors the AISDLC-453 fix/exempt options', () => {
    expect(STRUCTURAL_RECONCILIATION_OPTIONS.map((o) => o.id)).toEqual(['fix', 'exempt']);
  });
});

describe('Decision requests reuse RFC-0035 catalog shape (AC-8)', () => {
  it('statistical request → framework-calibration, reversible, three options, drift scope', () => {
    const r = evaluateStatisticalDrift(
      [
        { at: daysAgo(40), value: 0.3 },
        { at: daysAgo(25), value: 0.25 },
        { at: daysAgo(15), value: 0.2 },
      ],
      [true, true, true],
      NOW,
    );
    const evt = toStatisticalDriftEvent('soul-x', r);
    expect(evt).not.toBeNull();
    const req = toDecisionRequest(evt as DriftEvent);
    expect(req.source).toBe('framework-calibration');
    expect(req.reversible).toBe(true);
    expect(req.scope).toBe(DRIFT_DECISION_SCOPE);
    expect(req.options.map((o) => o.id)).toEqual([
      'confirm-as-evolution',
      'confirm-as-violation',
      'defer',
    ]);
    // Catalog option ids must be lowercase-dash slugs (decision-record OPTION_ID_PATTERN).
    for (const o of req.options) expect(o.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('structural request → emergent-finding, non-reversible (hard gate)', () => {
    const events = toStructuralDriftEvents({
      passed: false,
      coldStart: false,
      failures: [{ soulId: 'soul-a', message: 'phantom-Soul DID' }],
    });
    const req = toDecisionRequest(events[0]);
    expect(req.source).toBe('emergent-finding');
    expect(req.reversible).toBe(false);
    expect(req.scope).toBe(DRIFT_DECISION_SCOPE);
    expect(req.options.map((o) => o.id)).toEqual(['fix', 'exempt']);
  });
});
