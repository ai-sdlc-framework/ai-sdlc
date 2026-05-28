import { describe, expect, it } from 'vitest';
import {
  assessClusterSignificance,
  assessTier2Significance,
  checkSignalResidency,
  classifySaResonance,
  computeBaselineStat,
  computeZScore,
  DEFAULT_FLOODING_DETECTION_CONFIG,
  detectFlooding,
  filterSignalsByResidency,
  InMemoryQuarantineStore,
  isSignalQuarantined,
  SA_WEIGHT_MULTIPLIERS,
  unquarantineFlooded,
  type FloodingDetectionResult,
  type PerSourceBaseline,
  type QuarantineStore,
  type ResidencyRegimeDeclaration,
  type SignalFloodingDetectedDecision,
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

// ── AC #4 / AC #5: z-score flooding detector + cold-start + quarantine ─────

describe('detectFlooding — z-score detector (AISDLC-433)', () => {
  const baseAsOf = new Date('2026-05-20T12:00:00.000Z');

  function withinWindow(
    adapterName: string,
    sourceIdPrefix: string,
    n: number,
    minutesAgo = 30,
  ): RawSignal[] {
    const out: RawSignal[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        rawSignal({
          sourceId: `${sourceIdPrefix}-${i}`,
          sourceTimestamp: new Date(baseAsOf.getTime() - minutesAgo * 60 * 1000),
          metadata: { adapterName },
        }),
      );
    }
    return out;
  }

  // A consistent 7-day baseline of ~5 signals/day with low variance.
  const flatBaseline7d: PerSourceBaseline = {
    'source-a': [5, 4, 5, 6, 5, 5, 4],
    'source-b': [5, 5, 4, 6, 5, 5, 5],
    'source-c': [5, 5, 5, 5, 4, 6, 5],
  };

  it('returns status=empty-window when no signals fall in the detection window', () => {
    const result: FloodingDetectionResult = detectFlooding([], {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.status).toBe('empty-window');
    expect(result.decision).toBeUndefined();
  });

  it('returns status=calibrating when baseline has < baselineDays of history (cold-start AC #4)', () => {
    // Only 3 days of baseline for source-a → cold-start.
    const coldBaseline: PerSourceBaseline = { 'source-a': [5, 4, 6] };
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: coldBaseline,
    });
    expect(result.status).toBe('calibrating');
    expect(result.decision).toBeUndefined();
    expect(result.baselineDaysObserved).toBe(3);
  });

  it('returns status=clean when uniqueSources >= minUniqueSourcesForSuspicion (organic traffic)', () => {
    // Five distinct sources contributing — healthy organic. Even with elevated
    // volume per source, the diversity guard makes this NOT flooding.
    const signals = [
      ...withinWindow('source-a', 'a', 50),
      ...withinWindow('source-b', 'b', 50),
      ...withinWindow('source-c', 'c', 50),
      ...withinWindow('source-d', 'd', 50),
      ...withinWindow('source-e', 'e', 50),
    ];
    const wideBaseline: PerSourceBaseline = {
      'source-a': [5, 5, 5, 5, 5, 5, 5],
      'source-b': [5, 5, 5, 5, 5, 5, 5],
      'source-c': [5, 5, 5, 5, 5, 5, 5],
      'source-d': [5, 5, 5, 5, 5, 5, 5],
      'source-e': [5, 5, 5, 5, 5, 5, 5],
    };
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: wideBaseline,
    });
    expect(result.status).toBe('clean');
    expect(result.decision).toBeUndefined();
  });

  it('detects single-source flood and emits Decision with quarantine entries', () => {
    // source-a baseline ~5/day; window has 100 signals → z-score huge.
    // uniqueSources = 1 < minUniqueSourcesForSuspicion (3) → trigger condition met.
    const store = new InMemoryQuarantineStore();
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
      quarantineStore: store,
    });
    expect(result.status).toBe('flooded');
    expect(result.decision).toBeDefined();
    const decision = result.decision!;
    expect(decision.decision).toBe('signal-flooding-detected');
    expect(decision.flaggedSources).toHaveLength(1);
    expect(decision.flaggedSources[0]!.sourceId).toBe('source-a');
    expect(decision.flaggedSources[0]!.zScore).toBeGreaterThan(3.0);
    expect(decision.quarantinedSourceIds).toEqual(['source-a']);
    expect(decision.quarantineDurationHours).toBe(24);
    expect(store.getActiveEntries(baseAsOf).length).toBe(100);
  });

  it('detects coordinated low-volume burst across 2 sources (still < 3 unique) — AC #11', () => {
    // 2 sources × 30 signals each → 60 total. Each source baseline ~5/day; window
    // is one bucket so z-score huge. uniqueSources = 2 < 3 → trigger.
    const signals = [...withinWindow('source-a', 'a', 30), ...withinWindow('source-b', 'b', 30)];
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.status).toBe('flooded');
    expect(result.decision!.flaggedSources.length).toBe(2);
  });

  it('respects baseline drift: 6 signals on a 5±0.5 baseline does NOT trip (just above mean)', () => {
    // source-a baseline ~5/day stddev ~0.7; window has 6 signals → z-score < 3.
    // uniqueSources = 1 < 3 (would trigger if z-score crossed) — but z-score is below threshold.
    const signals = withinWindow('source-a', 'a', 6);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.status).toBe('clean');
  });

  it('falls back from adapterName to sourceId prefix when metadata missing', () => {
    const signals: RawSignal[] = [];
    for (let i = 0; i < 100; i++) {
      signals.push(
        rawSignal({
          sourceId: `zendesk-${i}`,
          sourceTimestamp: new Date(baseAsOf.getTime() - 10 * 60 * 1000),
          metadata: {},
        }),
      );
    }
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: { zendesk: [5, 5, 5, 5, 5, 5, 5] },
    });
    expect(result.status).toBe('flooded');
    expect(result.decision!.flaggedSources[0]!.sourceId).toBe('zendesk');
  });

  it('honours custom config (lower zScoreThreshold trips on smaller spike)', () => {
    const signals = withinWindow('source-a', 'a', 8); // mild spike
    const customConfig = {
      ...DEFAULT_FLOODING_DETECTION_CONFIG,
      zScoreThreshold: 1.5, // much more sensitive
    };
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      config: customConfig,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.status).toBe('flooded');
  });

  it('emits Decision with quarantineDurationHours=0 when quarantine is disabled', () => {
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
      quarantineConfig: { enabled: false, durationHours: 24 },
    });
    expect(result.status).toBe('flooded');
    expect(result.decision!.quarantineDurationHours).toBe(0);
    expect(result.decision!.quarantinedSourceIds).toEqual([]);
  });

  it('respects per-org override for quarantine duration', () => {
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
      quarantineConfig: { enabled: true, durationHours: 72 },
    });
    expect(result.decision!.quarantineDurationHours).toBe(72);
  });

  it('uses deterministic decision IDs when factory is supplied', () => {
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
      generateDecisionId: () => 'test-decision-id-1',
    });
    expect(result.decision!.decisionId).toBe('test-decision-id-1');
  });

  it('emits Decision detectedAt as ISO string matching asOf', () => {
    const signals = withinWindow('source-a', 'a', 100);
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.decision!.detectedAt).toBe(baseAsOf.toISOString());
  });

  it('reports baselineDaysObserved correctly across heterogeneous source baselines', () => {
    // source-a has 7 days, source-b has 3 days. baselineDays default = 7 → still
    // calibrating overall (max across sources is 7 — calibrated). Then trigger
    // only fires for source-a (source-b skipped at per-source level).
    const signals = [...withinWindow('source-a', 'a', 100), ...withinWindow('source-b', 'b', 100)];
    const mixed: PerSourceBaseline = {
      'source-a': [5, 5, 5, 5, 5, 5, 5],
      'source-b': [5, 5, 5],
    };
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: mixed,
    });
    expect(result.status).toBe('flooded');
    expect(result.baselineDaysObserved).toBe(7);
    expect(result.decision!.flaggedSources.map((f) => f.sourceId)).toEqual(['source-a']);
  });

  it('excludes signals outside the windowMinutes', () => {
    const signals = [
      // 2h ago — outside default 60min window
      ...withinWindow('source-a', 'a', 50, 120),
      // 10min ago — inside window
      ...withinWindow('source-a', 'b', 50, 10),
    ];
    const result = detectFlooding(signals, {
      asOf: baseAsOf,
      perSourceBaselines: flatBaseline7d,
    });
    expect(result.status).toBe('flooded');
    expect(result.decision!.signalCount).toBe(50);
  });
});

// Per-source statistics helpers — exercise the math primitives directly
describe('computeBaselineStat + computeZScore — math primitives', () => {
  it('computes mean + population stddev', () => {
    const stat = computeBaselineStat([5, 5, 5, 5, 5, 5, 5]);
    expect(stat.mean).toBe(5);
    expect(stat.stddev).toBe(0);
    expect(stat.sampleCount).toBe(7);
  });

  it('computes stddev for a variable baseline', () => {
    const stat = computeBaselineStat([1, 2, 3, 4, 5]);
    expect(stat.mean).toBe(3);
    // Population stddev: sqrt((4+1+0+1+4)/5) = sqrt(2)
    expect(stat.stddev).toBeCloseTo(Math.sqrt(2), 5);
  });

  it('z-score returns +Infinity when stddev is 0 and observation > mean', () => {
    const stat = computeBaselineStat([5, 5, 5, 5, 5]);
    expect(computeZScore(100, stat)).toBe(Number.POSITIVE_INFINITY);
  });

  it('z-score returns 0 when observation == mean and stddev is 0', () => {
    const stat = computeBaselineStat([5, 5, 5, 5, 5]);
    expect(computeZScore(5, stat)).toBe(0);
  });

  it('z-score returns standard deviations from mean for variable baseline', () => {
    const stat = computeBaselineStat([1, 2, 3, 4, 5]);
    // (10 - 3) / sqrt(2) ≈ 4.95
    expect(computeZScore(10, stat)).toBeCloseTo(7 / Math.sqrt(2), 5);
  });
});

// ── Quarantine lifecycle + operator unquarantine (AC #5, #8, #9) ────────────

describe('QuarantineStore + unquarantineFlooded — operator unblock path', () => {
  const asOf = new Date('2026-05-20T12:00:00.000Z');
  const oneDayMs = 24 * 60 * 60 * 1000;

  function flagSource(store: QuarantineStore, sourceId: string, decisionId: string): void {
    store.quarantine({
      sourceId,
      adapterSource: sourceId,
      decisionId,
      quarantinedAt: asOf,
      expiresAt: new Date(asOf.getTime() + oneDayMs),
      reason: 'z-score 4.5σ',
    });
  }

  it('isQuarantined returns true while the entry is active', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'dec-1');
    expect(store.isQuarantined('src-1', asOf)).toBe(true);
  });

  it('isQuarantined returns false after auto-expiry', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'dec-1');
    const after = new Date(asOf.getTime() + oneDayMs + 1000);
    expect(store.isQuarantined('src-1', after)).toBe(false);
  });

  it('getActiveEntries excludes auto-expired entries', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'dec-1');
    flagSource(store, 'src-2', 'dec-2');
    expect(store.getActiveEntries(asOf)).toHaveLength(2);
    const after = new Date(asOf.getTime() + oneDayMs + 1000);
    expect(store.getActiveEntries(after)).toHaveLength(0);
  });

  it('release removes entries for the given Decision', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'dec-1');
    flagSource(store, 'src-2', 'dec-2');
    store.release('dec-1', asOf);
    expect(store.isQuarantined('src-1', asOf)).toBe(false);
    expect(store.isQuarantined('src-2', asOf)).toBe(true);
  });

  it('unquarantineFlooded releases entries + emits false-positive Decision (AC #9)', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'flooding-decision-original');
    flagSource(store, 'src-2', 'flooding-decision-original');
    const decision = unquarantineFlooded({
      store,
      originalDecisionId: 'flooding-decision-original',
      operatorNote: 'Bug bash — genuine demand',
      asOf,
    });
    expect(decision).not.toBeNull();
    expect(decision!.decision).toBe('signal-flooding-false-positive');
    expect(decision!.originalDecisionId).toBe('flooding-decision-original');
    expect(decision!.releasedSourceIds.sort()).toEqual(['src-1', 'src-2']);
    expect(decision!.operatorNote).toBe('Bug bash — genuine demand');
    expect(store.isQuarantined('src-1', asOf)).toBe(false);
  });

  it('unquarantineFlooded returns null when Decision has no active entries (idempotent)', () => {
    const store = new InMemoryQuarantineStore();
    const decision = unquarantineFlooded({
      store,
      originalDecisionId: 'never-quarantined',
      asOf,
    });
    expect(decision).toBeNull();
  });

  it('end-to-end: detector populates store + operator unquarantines via Decision ID', () => {
    const store = new InMemoryQuarantineStore();
    const signals = [];
    for (let i = 0; i < 100; i++) {
      signals.push(
        rawSignal({
          sourceId: `s-${i}`,
          sourceTimestamp: new Date(asOf.getTime() - 10 * 60 * 1000),
          metadata: { adapterName: 'flooding-source' },
        }),
      );
    }
    const baseline: PerSourceBaseline = {
      'flooding-source': [5, 5, 5, 5, 5, 5, 5],
    };
    const detect = detectFlooding(signals, {
      asOf,
      perSourceBaselines: baseline,
      quarantineStore: store,
      generateDecisionId: () => 'flood-decision-e2e',
    });
    expect(detect.status).toBe('flooded');
    expect(store.getActiveEntries(asOf)).toHaveLength(100);

    // Operator clicks "Unquarantine" — emits false-positive Decision.
    const released = unquarantineFlooded({
      store,
      originalDecisionId: 'flood-decision-e2e',
      asOf,
    });
    expect(released).not.toBeNull();
    expect(released!.releasedSourceIds).toHaveLength(100);
    expect(store.getActiveEntries(asOf)).toHaveLength(0);
  });

  it('isSignalQuarantined helper returns false when no store is supplied (back-compat)', () => {
    const signal = rawSignal({ sourceId: 'src-x' });
    expect(isSignalQuarantined(signal, undefined)).toBe(false);
  });

  it('isSignalQuarantined helper consults the store when supplied', () => {
    const store = new InMemoryQuarantineStore();
    flagSource(store, 'src-1', 'dec-1');
    const signal = rawSignal({ sourceId: 'src-1' });
    expect(isSignalQuarantined(signal, store, asOf)).toBe(true);
    const sigOther = rawSignal({ sourceId: 'src-other' });
    expect(isSignalQuarantined(sigOther, store, asOf)).toBe(false);
  });
});

// ── AC #7: residency violation detection ────────────────────────────────────

describe('checkSignalResidency — AC #7', () => {
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

describe('filterSignalsByResidency — AC #7 convenience helper', () => {
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

// ── AC #8: Pipeline never halts (no thrown errors) ──────────────────────────

describe('AC #8 — pipeline never halts', () => {
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
    expect(detectFlooding([]).status).toBe('empty-window');
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

  it('flooding detection produces a Decision (not exception) under extreme attack', () => {
    const signals: RawSignal[] = [];
    for (let i = 0; i < 1000; i++) {
      signals.push(
        rawSignal({
          sourceId: `attack-${i}`,
          sourceTimestamp: new Date('2026-05-20T11:30:00.000Z'),
          metadata: { adapterName: 'source-a' },
        }),
      );
    }
    const result = detectFlooding(signals, {
      asOf: new Date('2026-05-20T12:00:00.000Z'),
      perSourceBaselines: { 'source-a': [5, 5, 5, 5, 5, 5, 5] },
    });
    expect(result.status).toBe('flooded');
    const decision: SignalFloodingDetectedDecision = result.decision!;
    expect(decision.flaggedSources[0]!.zScore).toBeGreaterThan(3);
    // Caller can act on Decision; nothing in the pipeline throws.
  });

  it('detectFlooding survives cold-start gracefully (no throw on partial baseline)', () => {
    const signals = [
      rawSignal({
        sourceId: 'src-1',
        sourceTimestamp: new Date('2026-05-20T11:50:00.000Z'),
        metadata: { adapterName: 'src' },
      }),
    ];
    expect(() =>
      detectFlooding(signals, {
        asOf: new Date('2026-05-20T12:00:00.000Z'),
        perSourceBaselines: { src: [5, 5] }, // only 2 days
      }),
    ).not.toThrow();
  });
});
