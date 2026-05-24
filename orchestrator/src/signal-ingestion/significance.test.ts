import { describe, expect, it } from 'vitest';
import {
  assessClusterSignificance,
  assessTier2Significance,
  checkSignalResidency,
  classifySaResonance,
  DEFAULT_FLOODING_DETECTION_CONFIG,
  detectFlooding,
  filterSignalsByResidency,
  SA_WEIGHT_MULTIPLIERS,
  type ResidencyRegimeDeclaration,
  type SignificanceAssessedCluster,
} from './significance.js';
import type { DemandCluster } from './clustering.js';
import type { RawSignal } from './types.js';
import {
  DEFAULT_SIGNAL_INGESTION_CONFIG,
  type SignalIngestionConfig,
  type Tier2SignificanceThreshold,
} from './config.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function cluster(overrides: Partial<DemandCluster> = {}): DemandCluster {
  const base: DemandCluster = {
    clusterId: 'cluster:test1234567890abcdef0000',
    members: [],
    signalCount: 10,
    uniqueSources: 5,
    tier1SignalCount: 3,
    tier2SignalCount: 7,
    oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    newestSignalAt: new Date('2026-05-15T00:00:00.000Z'),
    icpMatchRate: 0.5,
    churnCorrelation: 0.1,
    aggregateRecencyDecay: 0.9,
    // saResonance left undefined by default to test `pending` bucket
  };
  return { ...base, ...overrides };
}

function rawSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    sourceId: 'src-1',
    sourceTimestamp: new Date('2026-05-15T12:00:00.000Z'),
    payload: 'test signal',
    ...overrides,
  };
}

const ASOF = new Date('2026-05-20T00:00:00.000Z');

// ── AC #1: Tier 2 significance threshold ────────────────────────────────────

describe('assessTier2Significance — AC #1', () => {
  const threshold: Tier2SignificanceThreshold = {
    minSignalCount: 5,
    minUniqueSources: 3,
    minTier1SignalCount: 1,
    minClusterAgeDays: 7,
  };

  it('qualifies clusters that meet all four conditions', () => {
    const c = cluster({
      signalCount: 5,
      uniqueSources: 3,
      tier1SignalCount: 1,
      oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'), // 19 days old vs ASOF
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('qualified');
    expect(result.reasons).toEqual({
      signalCount: false,
      uniqueSources: false,
      tier1SignalCount: false,
      clusterAgeDays: false,
    });
  });

  it('marks cluster monitored when signalCount falls short', () => {
    const c = cluster({
      signalCount: 4,
      uniqueSources: 3,
      tier1SignalCount: 1,
      oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('monitored');
    expect(result.reasons.signalCount).toBe(true);
    expect(result.reasons.uniqueSources).toBe(false);
    expect(result.reasons.tier1SignalCount).toBe(false);
    expect(result.reasons.clusterAgeDays).toBe(false);
  });

  it('marks cluster monitored when uniqueSources falls short', () => {
    const c = cluster({
      signalCount: 5,
      uniqueSources: 2,
      tier1SignalCount: 1,
      oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('monitored');
    expect(result.reasons.uniqueSources).toBe(true);
  });

  it('marks cluster monitored when tier1SignalCount falls short', () => {
    const c = cluster({
      signalCount: 5,
      uniqueSources: 3,
      tier1SignalCount: 0, // no Tier 1 anchor — community-only buzz
      oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('monitored');
    expect(result.reasons.tier1SignalCount).toBe(true);
  });

  it('marks cluster monitored when cluster is too young', () => {
    const c = cluster({
      signalCount: 5,
      uniqueSources: 3,
      tier1SignalCount: 1,
      oldestSignalAt: new Date('2026-05-18T00:00:00.000Z'), // 2 days old vs ASOF
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('monitored');
    expect(result.reasons.clusterAgeDays).toBe(true);
  });

  it('reports all four reasons when nothing passes', () => {
    const c = cluster({
      signalCount: 1,
      uniqueSources: 1,
      tier1SignalCount: 0,
      oldestSignalAt: new Date('2026-05-19T00:00:00.000Z'), // 1 day
    });
    const result = assessTier2Significance(c, threshold, ASOF);
    expect(result.state).toBe('monitored');
    expect(result.reasons).toEqual({
      signalCount: true,
      uniqueSources: true,
      tier1SignalCount: true,
      clusterAgeDays: true,
    });
  });

  it('uses default threshold when none supplied', () => {
    const c = cluster({
      signalCount: 5,
      uniqueSources: 3,
      tier1SignalCount: 1,
      oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const result = assessTier2Significance(c, undefined, ASOF);
    expect(result.state).toBe('qualified');
  });
});

// ── AC #2: SA resonance filter ──────────────────────────────────────────────

describe('classifySaResonance — AC #2', () => {
  const thresholds = DEFAULT_SIGNAL_INGESTION_CONFIG.saResonanceThresholds;

  it('classifies high SA as full', () => {
    expect(classifySaResonance(cluster({ saResonance: 0.9 }), thresholds)).toBe('full');
    expect(classifySaResonance(cluster({ saResonance: 0.7 }), thresholds)).toBe('full');
  });

  it('classifies mid SA as discounted', () => {
    expect(classifySaResonance(cluster({ saResonance: 0.6 }), thresholds)).toBe('discounted');
    expect(classifySaResonance(cluster({ saResonance: 0.4 }), thresholds)).toBe('discounted');
  });

  it('classifies low (but non-zero) SA as low-sa-review', () => {
    expect(classifySaResonance(cluster({ saResonance: 0.3 }), thresholds)).toBe('low-sa-review');
    expect(classifySaResonance(cluster({ saResonance: 0.01 }), thresholds)).toBe('low-sa-review');
  });

  it('classifies zero/below-excluded SA as out-of-scope', () => {
    expect(classifySaResonance(cluster({ saResonance: 0.0 }), thresholds)).toBe('out-of-scope');
  });

  it('classifies undefined SA as pending (fail-closed)', () => {
    expect(classifySaResonance(cluster({ saResonance: undefined }), thresholds)).toBe('pending');
  });

  it('exposes correct SA weight multipliers per RFC-0030 §9', () => {
    expect(SA_WEIGHT_MULTIPLIERS.full).toBe(1.0);
    expect(SA_WEIGHT_MULTIPLIERS.discounted).toBe(0.7);
    expect(SA_WEIGHT_MULTIPLIERS['low-sa-review']).toBe(0.3);
    expect(SA_WEIGHT_MULTIPLIERS['out-of-scope']).toBe(0.0);
    expect(SA_WEIGHT_MULTIPLIERS.pending).toBe(0.0);
  });

  it('honours custom thresholds', () => {
    const custom = { fullWeight: 0.9, discounted: 0.6, excluded: 0.1 };
    expect(classifySaResonance(cluster({ saResonance: 0.85 }), custom)).toBe('discounted');
    expect(classifySaResonance(cluster({ saResonance: 0.95 }), custom)).toBe('full');
    expect(classifySaResonance(cluster({ saResonance: 0.2 }), custom)).toBe('low-sa-review');
    expect(classifySaResonance(cluster({ saResonance: 0.05 }), custom)).toBe('out-of-scope');
  });
});

// ── AC #3: Low-SA decisions surface for Product Lead review ─────────────────

describe('assessClusterSignificance — AC #3 low-SA decisions', () => {
  it('emits signal-low-sa-for-review Decision for low-but-real-demand clusters', () => {
    const clusters = [
      cluster({
        clusterId: 'cluster:lowSA',
        saResonance: 0.2, // low but > 0 → low-sa-review
        signalCount: 50, // high volume
        uniqueSources: 10,
        tier1SignalCount: 3,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.lowSaDecisions).toHaveLength(1);
    const decision = result.lowSaDecisions[0]!;
    expect(decision.type).toBe('Decision');
    expect(decision.decision).toBe('signal-low-sa-for-review');
    expect(decision.clusterId).toBe('cluster:lowSA');
    expect(decision.saResonance).toBe(0.2);
    expect(decision.signalCount).toBe(50);
  });

  it('emits low-SA Decision even when cluster is monitored (below significance)', () => {
    // AC #3: low-SA-but-high-volume signals logged for review — the operator
    // should see this even when the cluster hasn't crossed the significance bar.
    const clusters = [
      cluster({
        clusterId: 'cluster:lowSAMonitored',
        saResonance: 0.2,
        signalCount: 3, // below significance threshold (default 5)
        uniqueSources: 2,
        tier1SignalCount: 0,
        oldestSignalAt: new Date('2026-05-19T00:00:00.000Z'), // 1 day
      }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.assessments[0]!.tier2Significance).toBe('monitored');
    expect(result.lowSaDecisions).toHaveLength(1);
    expect(result.lowSaDecisions[0]!.clusterId).toBe('cluster:lowSAMonitored');
  });

  it('does NOT emit low-SA Decision for full-weight clusters', () => {
    const clusters = [cluster({ saResonance: 0.85 })];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.lowSaDecisions).toHaveLength(0);
  });

  it('does NOT emit low-SA Decision when saResonance is undefined (pending)', () => {
    const clusters = [cluster({ saResonance: undefined })];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.lowSaDecisions).toHaveLength(0);
    expect(result.assessments[0]!.saResonanceBucket).toBe('pending');
  });

  it('emits signal-out-of-scope Decision for SA == excluded threshold', () => {
    const clusters = [
      cluster({
        clusterId: 'cluster:oos',
        saResonance: 0.0,
        signalCount: 20,
      }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.outOfScopeDecisions).toHaveLength(1);
    expect(result.outOfScopeDecisions[0]!.clusterId).toBe('cluster:oos');
    expect(result.outOfScopeDecisions[0]!.decision).toBe('signal-out-of-scope');
  });
});

// ── assessClusterSignificance — combined eligibility + multiplier ───────────

describe('assessClusterSignificance — combined verdict', () => {
  it('computes eligibleForD1 = true only when qualified AND SA bucket is full/discounted/low-sa-review', () => {
    const clusters = [
      cluster({
        clusterId: 'cluster:elig',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: 0.85,
      }),
      cluster({
        clusterId: 'cluster:monitored',
        signalCount: 1, // < significance
        uniqueSources: 1,
        tier1SignalCount: 0,
        oldestSignalAt: new Date('2026-05-19T00:00:00.000Z'),
        saResonance: 0.85,
      }),
      cluster({
        clusterId: 'cluster:oos',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: 0.0,
      }),
      cluster({
        clusterId: 'cluster:pending',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: undefined,
      }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    const byId = new Map(result.assessments.map((a) => [a.cluster.clusterId, a]));
    expect(byId.get('cluster:elig')!.eligibleForD1).toBe(true);
    expect(byId.get('cluster:monitored')!.eligibleForD1).toBe(false);
    expect(byId.get('cluster:oos')!.eligibleForD1).toBe(false);
    expect(byId.get('cluster:pending')!.eligibleForD1).toBe(false);
  });

  it('multiplies significance × SA bucket for d1WeightMultiplier', () => {
    const clusters = [
      // qualified + full → 1.0
      cluster({
        clusterId: 'cluster:a',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: 0.85,
      }),
      // qualified + discounted → 0.7
      cluster({
        clusterId: 'cluster:b',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: 0.5,
      }),
      // qualified + low-sa-review → 0.3
      cluster({
        clusterId: 'cluster:c',
        signalCount: 10,
        uniqueSources: 5,
        tier1SignalCount: 2,
        oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
        saResonance: 0.2,
      }),
      // monitored + full → 0.0 (significance trumps SA)
      cluster({
        clusterId: 'cluster:d',
        signalCount: 1,
        uniqueSources: 1,
        tier1SignalCount: 0,
        oldestSignalAt: new Date('2026-05-19T00:00:00.000Z'),
        saResonance: 0.85,
      }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    const byId = new Map<string, SignificanceAssessedCluster>(
      result.assessments.map((a) => [a.cluster.clusterId, a]),
    );
    expect(byId.get('cluster:a')!.d1WeightMultiplier).toBe(1.0);
    expect(byId.get('cluster:b')!.d1WeightMultiplier).toBe(0.7);
    expect(byId.get('cluster:c')!.d1WeightMultiplier).toBe(0.3);
    expect(byId.get('cluster:d')!.d1WeightMultiplier).toBe(0.0);
  });

  it('preserves all clusters in output regardless of state (no silent drops)', () => {
    const clusters = [
      cluster({ clusterId: 'c1', saResonance: 0.0, signalCount: 1 }),
      cluster({ clusterId: 'c2', saResonance: undefined }),
      cluster({ clusterId: 'c3', saResonance: 0.9 }),
    ];
    const result = assessClusterSignificance(clusters, { asOf: ASOF });
    expect(result.assessments).toHaveLength(3);
    expect(result.assessments.map((a) => a.cluster.clusterId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('honours custom config', () => {
    const customConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      tier2SignificanceThreshold: {
        minSignalCount: 2,
        minUniqueSources: 1,
        minTier1SignalCount: 0,
        minClusterAgeDays: 0,
      },
    };
    const clusters = [
      cluster({
        signalCount: 2,
        uniqueSources: 1,
        tier1SignalCount: 0,
        oldestSignalAt: new Date('2026-05-19T00:00:00.000Z'),
        saResonance: 0.9,
      }),
    ];
    const result = assessClusterSignificance(clusters, {
      config: customConfig,
      asOf: ASOF,
    });
    expect(result.assessments[0]!.tier2Significance).toBe('qualified');
  });
});

// ── AC #4 + AC #5: flooding detection ───────────────────────────────────────

describe('detectFlooding — AC #4 + AC #5', () => {
  const baseAsOf = new Date('2026-05-20T12:00:00.000Z');

  function recentSignal(adapterName: string, sourceId: string, hoursAgo = 1): RawSignal {
    return rawSignal({
      sourceId,
      sourceTimestamp: new Date(baseAsOf.getTime() - hoursAgo * 60 * 60 * 1000),
      metadata: { adapterName },
    });
  }

  it('returns null when window is empty', () => {
    const result = detectFlooding([], { asOf: baseAsOf });
    expect(result).toBeNull();
  });

  it('returns null when no indicators trip (normal traffic)', () => {
    const signals = [
      recentSignal('source-a', 'a-1', 1),
      recentSignal('source-b', 'b-1', 2),
      recentSignal('source-c', 'c-1', 3),
    ];
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 5,
    });
    expect(result).toBeNull();
  });

  it('detects volume spike (severity low)', () => {
    // 20 signals across 2 sources → mean 10 per source vs baseline 1 → 10× spike
    // also: 2 sources / 20 signals = 0.1 diversity ratio < 0.2 → diversity trips too
    // need lots of distinct sources to avoid the diversity trip
    const signals: RawSignal[] = [];
    for (let i = 0; i < 20; i++) signals.push(recentSignal(`source-${i}`, `s${i}-1`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 0.1, // tiny baseline; window mean = 1 > 3 × 0.1
    });
    expect(result).not.toBeNull();
    expect(result!.indicators.volumeSpike).toBe(true);
    expect(result!.indicators.lowSourceDiversity).toBe(false);
    expect(result!.severity).toBe('low');
    expect(result!.response).toBe('auto-throttle');
  });

  it('detects low source diversity (severity low when only this indicator trips)', () => {
    // 20 signals from 2 sources — diversity ratio 0.1 < 0.2 trips
    // mean = 10 per source; baseline 100 → no volume spike
    const signals: RawSignal[] = [];
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-b', `b-${i}`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100, // high baseline → no volume spike
    });
    expect(result).not.toBeNull();
    expect(result!.indicators.lowSourceDiversity).toBe(true);
    expect(result!.indicators.volumeSpike).toBe(false);
    expect(result!.severity).toBe('low');
  });

  it('detects per-source baseline drift (severity low when only this trips)', () => {
    // source-a normal baseline 1; window has 10 signals from source-a → drift 10× > 5×
    const signals: RawSignal[] = [];
    // Distribute across many sources to avoid diversity + volume trip
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 50; i++) signals.push(recentSignal(`source-${i}`, `o-${i}`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100, // high baseline → no volume spike
      perSourceBaselines: { 'source-a': 1 }, // a should have ~1 signal; got 10
    });
    expect(result).not.toBeNull();
    expect(result!.indicators.perSourceBaselineDrift).toBe(true);
    expect(result!.driftingSources).toEqual(['source-a']);
    expect(result!.severity).toBe('low');
  });

  it('produces medium severity when two indicators trip', () => {
    // 30 signals across 3 sources — low diversity (0.1) + volume spike
    const signals: RawSignal[] = [];
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-b', `b-${i}`, 1));
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-c', `c-${i}`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 1, // baseline 1, mean 10 per source = spike
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.response).toBe('auto-throttle-and-review');
    const trippedCount =
      Number(result!.indicators.volumeSpike) +
      Number(result!.indicators.lowSourceDiversity) +
      Number(result!.indicators.perSourceBaselineDrift);
    expect(trippedCount).toBe(2);
  });

  it('produces high severity when all three indicators trip', () => {
    // 20 signals from 2 sources, baseline 1, source-a baseline 1 (drifted 10×)
    const signals: RawSignal[] = [];
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 10; i++) signals.push(recentSignal('source-b', `b-${i}`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 0.5, // low baseline → volume spike
      perSourceBaselines: { 'source-a': 1, 'source-b': 1 },
    });
    expect(result).not.toBeNull();
    expect(result!.indicators.volumeSpike).toBe(true);
    expect(result!.indicators.lowSourceDiversity).toBe(true);
    expect(result!.indicators.perSourceBaselineDrift).toBe(true);
    expect(result!.severity).toBe('high');
    expect(result!.response).toBe('operator-review');
  });

  it('suppresses diversity check when below minSignalCountForDiversityCheck', () => {
    // 5 signals from 1 source — diversity ratio 0.2 normally trips, but below
    // minSignalCountForDiversityCheck (10) so it should not.
    const signals: RawSignal[] = [];
    for (let i = 0; i < 5; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100, // no spike
    });
    expect(result).toBeNull(); // nothing trips
  });

  it('excludes signals outside the detection window', () => {
    const signals: RawSignal[] = [
      // outside the 24h window
      recentSignal('source-a', 'a-old', 48),
      recentSignal('source-b', 'b-old', 48),
      recentSignal('source-c', 'c-old', 48),
      // inside the window
      recentSignal('source-a', 'a-new', 1),
    ];
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100,
    });
    // Only 1 signal in window → no indicators trip
    expect(result).toBeNull();
  });

  it('uses fallback resolveSourceName from sourceId prefix when adapterName missing', () => {
    // No adapterName → falls back to before-dash prefix
    const signals: RawSignal[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push(
        rawSignal({ sourceId: `zendesk-${i}`, sourceTimestamp: baseAsOf, metadata: {} }),
      );
    }
    for (let i = 0; i < 12; i++) {
      signals.push(
        rawSignal({ sourceId: `discourse-${i}`, sourceTimestamp: baseAsOf, metadata: {} }),
      );
    }
    // 24 signals / 2 sources = diversity ratio 0.083 < 0.2 → trips
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.indicators.lowSourceDiversity).toBe(true);
    expect(result!.uniqueSources).toBe(2); // zendesk, discourse
  });

  it('falls back gracefully when no population baseline supplied', () => {
    // populationBaseline = 0 → uses small-population guard
    // 12 signals, 2 sources, mean = 6 per source — exceeds default multiplier 3
    const signals: RawSignal[] = [];
    for (let i = 0; i < 6; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 6; i++) signals.push(recentSignal('source-b', `b-${i}`, 1));
    const result = detectFlooding(signals, { asOf: baseAsOf });
    // Spike trips (mean 6 > 3), diversity ratio 2/12 = 0.166 trips, no per-source baseline
    expect(result).not.toBeNull();
    expect(result!.indicators.volumeSpike).toBe(true);
    expect(result!.indicators.lowSourceDiversity).toBe(true);
  });

  it('reports max source drift ratio across all sources', () => {
    const signals: RawSignal[] = [];
    for (let i = 0; i < 6; i++) signals.push(recentSignal('source-a', `a-${i}`, 1));
    for (let i = 0; i < 30; i++) signals.push(recentSignal('source-b', `b-${i}`, 1));
    for (let i = 0; i < 30; i++) signals.push(recentSignal(`source-${i}`, `o-${i}`, 1)); // distract
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      populationBaselineSignalsPerSource: 100, // no spike
      perSourceBaselines: { 'source-a': 1, 'source-b': 5 }, // a→6×, b→6×
    });
    expect(result).not.toBeNull();
    expect(result!.maxSourceBaselineDriftRatio).toBeCloseTo(6, 1);
  });

  it('uses custom config when supplied', () => {
    const customConfig = {
      ...DEFAULT_FLOODING_DETECTION_CONFIG,
      windowHours: 1,
      volumeSpikeMultiplier: 100,
    };
    const signals: RawSignal[] = [];
    for (let i = 0; i < 20; i++) signals.push(recentSignal(`source-${i}`, `s-${i}`, 0.5));
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      config: customConfig,
      populationBaselineSignalsPerSource: 1, // 1 × 100 multiplier = 100 threshold, mean = 1
    });
    // Window mean = 1 per source < 100 threshold → no spike
    expect(result).toBeNull();
  });
});

// ── AC #6: residency violation detection ────────────────────────────────────

describe('checkSignalResidency — AC #6', () => {
  const declaration: ResidencyRegimeDeclaration = {
    regimes: ['gdpr'],
    allowedRegionsByRegime: { gdpr: ['eu', 'gb'] },
  };

  it('permits signals from allowed regions', () => {
    const signal = rawSignal({ region: 'eu' });
    const result = checkSignalResidency(signal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });

  it('refuses signals from disallowed regions', () => {
    const signal = rawSignal({ region: 'us' });
    const result = checkSignalResidency(signal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(false);
    if (result.permitted) throw new Error('unreachable');
    expect(result.decision.type).toBe('Decision');
    expect(result.decision.decision).toBe('signal-residency-violation');
    expect(result.decision.violatedRegimes).toEqual(['gdpr']);
    expect(result.decision.allowedRegions).toEqual(['eu', 'gb']);
    expect(result.decision.signalRegion).toBe('us');
    expect(result.decision.adapter).toBe('signal-source-support-ticket');
  });

  it('handles case-insensitive region comparison', () => {
    const signal = rawSignal({ region: 'EU' });
    const result = checkSignalResidency(signal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });

  it('permits signals when no regimes are declared', () => {
    const empty: ResidencyRegimeDeclaration = { regimes: [], allowedRegionsByRegime: {} };
    const signal = rawSignal({ region: 'jp' });
    const result = checkSignalResidency(signal, empty, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });

  it('permits signals with no region metadata (visible-gap, not failure)', () => {
    const signal = rawSignal({ region: undefined });
    const result = checkSignalResidency(signal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });

  it('reports multiple violated regimes when signal violates several', () => {
    const multiRegimeDeclaration: ResidencyRegimeDeclaration = {
      regimes: ['gdpr', 'hipaa'],
      allowedRegionsByRegime: {
        gdpr: ['eu', 'gb'],
        hipaa: ['us'],
      },
    };
    const signal = rawSignal({ region: 'jp' });
    const result = checkSignalResidency(
      signal,
      multiRegimeDeclaration,
      'signal-source-community-thread',
    );
    expect(result.permitted).toBe(false);
    if (result.permitted) throw new Error('unreachable');
    expect(result.decision.violatedRegimes.sort()).toEqual(['gdpr', 'hipaa']);
    expect(result.decision.allowedRegions.sort()).toEqual(['eu', 'gb', 'us']);
  });

  it('refuses all signals when an active regime has no allowed regions', () => {
    const broken: ResidencyRegimeDeclaration = {
      regimes: ['gdpr'],
      allowedRegionsByRegime: { gdpr: [] }, // misconfigured — no allowed regions
    };
    const signal = rawSignal({ region: 'eu' });
    const result = checkSignalResidency(signal, broken, 'signal-source-support-ticket');
    expect(result.permitted).toBe(false);
    if (result.permitted) throw new Error('unreachable');
    expect(result.decision.violatedRegimes).toEqual(['gdpr']);
  });

  it('permits when signal matches one of multiple intersecting regimes', () => {
    // gdpr allows eu, gb; hipaa allows eu, us → signal from eu permitted
    const declaration: ResidencyRegimeDeclaration = {
      regimes: ['gdpr', 'hipaa'],
      allowedRegionsByRegime: {
        gdpr: ['eu', 'gb'],
        hipaa: ['eu', 'us'],
      },
    };
    const signal = rawSignal({ region: 'eu' });
    const result = checkSignalResidency(signal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });
});

describe('filterSignalsByResidency — AC #6 convenience helper', () => {
  it('separates permitted signals from refused ones and emits per-signal decisions', () => {
    const declaration: ResidencyRegimeDeclaration = {
      regimes: ['gdpr'],
      allowedRegionsByRegime: { gdpr: ['eu'] },
    };
    const signals: RawSignal[] = [
      rawSignal({ sourceId: 'a', region: 'eu' }),
      rawSignal({ sourceId: 'b', region: 'us' }),
      rawSignal({ sourceId: 'c', region: 'jp' }),
      rawSignal({ sourceId: 'd', region: 'eu' }),
    ];
    const { permitted, decisions } = filterSignalsByResidency(
      signals,
      declaration,
      'signal-source-community-thread',
    );
    expect(permitted.map((s) => s.sourceId)).toEqual(['a', 'd']);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.sourceId).sort()).toEqual(['b', 'c']);
    expect(decisions.every((d) => d.adapter === 'signal-source-community-thread')).toBe(true);
  });

  it('returns all signals when no regimes are active', () => {
    const declaration: ResidencyRegimeDeclaration = { regimes: [], allowedRegionsByRegime: {} };
    const signals = [rawSignal({ sourceId: 'a', region: 'us' })];
    const { permitted, decisions } = filterSignalsByResidency(
      signals,
      declaration,
      'signal-source-support-ticket',
    );
    expect(permitted).toEqual(signals);
    expect(decisions).toHaveLength(0);
  });
});

// ── AC #7: Pipeline never halts (no thrown errors) ──────────────────────────

describe('AC #7 — pipeline never halts', () => {
  it('assessClusterSignificance never throws on empty input', () => {
    expect(() => assessClusterSignificance([])).not.toThrow();
    const result = assessClusterSignificance([]);
    expect(result.assessments).toEqual([]);
    expect(result.lowSaDecisions).toEqual([]);
    expect(result.outOfScopeDecisions).toEqual([]);
  });

  it('assessClusterSignificance never throws on clusters with undefined SA (all pending)', () => {
    const clusters = [cluster({ saResonance: undefined }), cluster({ saResonance: undefined })];
    expect(() => assessClusterSignificance(clusters, { asOf: ASOF })).not.toThrow();
  });

  it('detectFlooding never throws on empty input', () => {
    expect(() => detectFlooding([])).not.toThrow();
    expect(detectFlooding([])).toBeNull();
  });

  it('detectFlooding never throws with malformed metadata', () => {
    const signals = [
      rawSignal({ metadata: undefined }),
      rawSignal({ metadata: { adapterName: null as unknown as string } }),
      rawSignal({ metadata: {} }),
    ];
    expect(() => detectFlooding(signals, { asOf: ASOF })).not.toThrow();
  });

  it('checkSignalResidency never throws on edge-case declarations', () => {
    const cases: ResidencyRegimeDeclaration[] = [
      { regimes: [], allowedRegionsByRegime: {} },
      { regimes: ['gdpr'], allowedRegionsByRegime: {} },
      { regimes: ['gdpr', 'hipaa'], allowedRegionsByRegime: { gdpr: ['eu'] } },
    ];
    for (const declaration of cases) {
      expect(() =>
        checkSignalResidency(
          rawSignal({ region: 'us' }),
          declaration,
          'signal-source-support-ticket',
        ),
      ).not.toThrow();
    }
  });

  it('flooding detection produces a Decision (not exception) even at extreme severity', () => {
    const signals: RawSignal[] = [];
    for (let i = 0; i < 1000; i++) {
      signals.push(
        rawSignal({
          sourceId: `attack-${i}`,
          sourceTimestamp: new Date('2026-05-20T11:00:00.000Z'),
          metadata: { adapterName: 'source-a' },
        }),
      );
    }
    const result = detectFlooding(signals, {
      asOf: new Date('2026-05-20T12:00:00.000Z'),
      populationBaselineSignalsPerSource: 1,
      perSourceBaselines: { 'source-a': 1 },
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    // Caller can act on Decision; nothing in the pipeline throws.
  });
});
