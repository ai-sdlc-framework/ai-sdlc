/**
 * Unit tests for RFC-0030 Phase 5 — D1 formula reformulation + composition
 * + RFC-0008 PPA integration helper.
 *
 * Test plan maps to task ACs:
 *   AC #1 — `computeClusterD1` + `aggregateD1FromClusters` apply §10 formula
 *           with weight + filter components.
 *   AC #2 — `composeD1Inputs` non-replacement: both inputs feed D1 when both
 *           are present.
 *   AC #3 — `enrichDemandSignalFromClusters` flows into the Sα₁ + Eρ₅
 *           admission composite via `PriorityInput.demandSignal`.
 *   AC #4 — Backward compat: pipeline disabled → composed score = backlog
 *           input unchanged.
 *   AC #5 — Weight balancing per `d1Composition` config; degenerate configs
 *           fall back to 50/50.
 *   AC #6 — Full pipeline → cluster → D1 → admission integration test lives
 *           in `signal-ingestion.test.ts`; this file covers the per-stage
 *           contracts.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateD1FromClusters,
  composeD1Inputs,
  computeClusterD1,
  enrichDemandSignalFromClusters,
} from './d1.js';
import type { ClusterMatcher } from './d1.js';
import type { DemandCluster } from './clustering.js';
import type { ClusteredSignalInput } from './clustering-types.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG, type SignalIngestionConfig } from './config.js';
import type { ICPResonance } from './classifier.js';
import { InMemoryQuarantineStore, type SignificanceAssessedCluster } from './significance.js';
import type { CustomerTier, RawSignal, SignalTier } from './types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function rawSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    sourceId: 'sig-1',
    sourceTimestamp: new Date('2026-05-15T00:00:00.000Z'),
    payload: 'test',
    ...overrides,
  };
}

function clusterMember(
  customerTier: CustomerTier,
  icpResonance: ICPResonance,
  recencyDecay: number,
  adapterTier: SignalTier = 1,
  sourceId = 'sig-x',
): ClusteredSignalInput {
  return {
    signal: rawSignal({ sourceId }),
    customerTier,
    icpResonance,
    recencyDecay,
    adapterTier,
  };
}

function cluster(overrides: Partial<DemandCluster> = {}): DemandCluster {
  const base: DemandCluster = {
    clusterId: 'cluster:default',
    members: [
      clusterMember('enterprise', 'strong', 0.9, 1, 'sig-a'),
      clusterMember('mid', 'partial', 0.8, 1, 'sig-b'),
    ],
    signalCount: 2,
    uniqueSources: 2,
    tier1SignalCount: 2,
    tier2SignalCount: 0,
    oldestSignalAt: new Date('2026-05-01T00:00:00.000Z'),
    newestSignalAt: new Date('2026-05-15T00:00:00.000Z'),
    icpMatchRate: 0.5,
    churnCorrelation: 0,
    aggregateRecencyDecay: 0.85,
    saResonance: 0.85,
  };
  return { ...base, ...overrides };
}

function assessedCluster(
  clusterOverrides: Partial<DemandCluster> = {},
  assessmentOverrides: Partial<Omit<SignificanceAssessedCluster, 'cluster'>> = {},
): SignificanceAssessedCluster {
  return {
    cluster: cluster(clusterOverrides),
    tier2Significance: 'qualified',
    tier2Reasons: {
      signalCount: false,
      uniqueSources: false,
      tier1SignalCount: false,
      clusterAgeDays: false,
    },
    saResonanceBucket: 'full',
    eligibleForD1: true,
    d1WeightMultiplier: 1.0,
    ...assessmentOverrides,
  };
}

// ── AC #1: §10 formula per cluster ──────────────────────────────────────────

describe('computeClusterD1 — AC #1 §10 formula', () => {
  it('sums per-member weight × cluster SA multiplier (full bucket)', () => {
    const assessment = assessedCluster();
    const result = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG);

    // Member 1: Tier1 base(1.0) × enterprise(3.0) × strong(1.5) × decay(0.9) = 4.05
    // Member 2: Tier1 base(1.0) × mid(1.5) × partial(1.0) × decay(0.8) = 1.2
    // Sum = 5.25, SA bucket 'full' multiplier 1.0 → rawScore = 5.25
    expect(result.rawScore).toBeCloseTo(5.25, 5);
    expect(result.eligible).toBe(true);
    expect(result.signalCount).toBe(2);
    expect(result.normalizedScore).toBe(0); // pre-normalisation
  });

  it('applies discounted SA bucket multiplier (0.7)', () => {
    const assessment = assessedCluster(
      { saResonance: 0.5 },
      { saResonanceBucket: 'discounted', d1WeightMultiplier: 0.7 },
    );
    const result = computeClusterD1(assessment);
    // sum 5.25 × 0.7 = 3.675
    expect(result.rawScore).toBeCloseTo(3.675, 5);
  });

  it('applies low-sa-review SA bucket multiplier (0.3)', () => {
    const assessment = assessedCluster(
      { saResonance: 0.2 },
      { saResonanceBucket: 'low-sa-review', d1WeightMultiplier: 0.3 },
    );
    const result = computeClusterD1(assessment);
    // sum 5.25 × 0.3 = 1.575
    expect(result.rawScore).toBeCloseTo(1.575, 5);
  });

  it('zeros score when cluster is ineligible (monitored)', () => {
    const assessment = assessedCluster(
      {},
      {
        eligibleForD1: false,
        tier2Significance: 'monitored',
        d1WeightMultiplier: 0,
      },
    );
    const result = computeClusterD1(assessment);
    expect(result.rawScore).toBe(0);
    expect(result.eligible).toBe(false);
  });

  it('zeros score when SA bucket is out-of-scope', () => {
    const assessment = assessedCluster(
      { saResonance: 0 },
      {
        saResonanceBucket: 'out-of-scope',
        eligibleForD1: false,
        d1WeightMultiplier: 0,
      },
    );
    expect(computeClusterD1(assessment).rawScore).toBe(0);
  });

  it('handles Tier 2 members with reduced base weight 0.3', () => {
    const tier2Only = cluster({
      clusterId: 'cluster:tier2',
      members: [clusterMember('smb', 'strong', 1.0, 2, 'sig-t2')], // base 0.3
      tier1SignalCount: 0,
      tier2SignalCount: 1,
    });
    const assessment = assessedCluster();
    assessment.cluster = tier2Only;
    const result = computeClusterD1(assessment);
    // 0.3 × smb(1.0) × strong(1.5) × 1.0 = 0.45
    expect(result.rawScore).toBeCloseTo(0.45, 5);
  });

  it('defaults adapterTier to Tier 1 when missing on member', () => {
    const noTier = cluster({
      members: [
        {
          signal: rawSignal({ sourceId: 'sig-no-tier' }),
          customerTier: 'smb',
          icpResonance: 'weak',
          recencyDecay: 1.0,
        },
      ],
    });
    const assessment = assessedCluster();
    assessment.cluster = noTier;
    const result = computeClusterD1(assessment);
    // 1.0 × smb(1.0) × weak(0.5) × 1.0 = 0.5 (default Tier 1)
    expect(result.rawScore).toBeCloseTo(0.5, 5);
  });

  it('respects custom config overrides (different tier multiplier)', () => {
    const custom: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      tierMultipliers: {
        enterprise: 10.0,
        mid: 1.0,
        smb: 1.0,
        free: 1.0,
        churned: 1.0,
      },
    };
    const assessment = assessedCluster();
    const result = computeClusterD1(assessment, custom);
    // Member1: enterprise(10) × strong(1.5) × 0.9 = 13.5
    // Member2: mid(1.0) × partial(1.0) × 0.8 = 0.8 → 14.3
    expect(result.rawScore).toBeCloseTo(14.3, 5);
  });
});

// ── AC #1 continued: §10 final-line normalisation ───────────────────────────

describe('aggregateD1FromClusters — AC #1 normalisation', () => {
  it('normalises raw scores against population max → 1.0 ceiling', () => {
    const a = assessedCluster({ clusterId: 'cluster:a' }); // raw 5.25
    const b = assessedCluster({
      clusterId: 'cluster:b',
      members: [clusterMember('smb', 'weak', 0.5, 1, 'sig-b1')], // 1×1×0.5×0.5 = 0.25
    });
    const result = aggregateD1FromClusters([a, b]);

    expect(result.maxRawScore).toBeCloseTo(5.25, 5);
    expect(result.clusters[0]!.normalizedScore).toBeCloseTo(1.0, 5);
    expect(result.clusters[1]!.normalizedScore).toBeCloseTo(0.25 / 5.25, 5);
  });

  it('mean normalised score covers eligible clusters only', () => {
    const a = assessedCluster({ clusterId: 'cluster:a' });
    const monitored = assessedCluster(
      { clusterId: 'cluster:m' },
      {
        eligibleForD1: false,
        tier2Significance: 'monitored',
        d1WeightMultiplier: 0,
      },
    );
    const result = aggregateD1FromClusters([a, monitored]);
    // Eligible mean = 1.0 (the only eligible cluster normalises to itself)
    expect(result.meanNormalizedScore).toBeCloseTo(1.0, 5);
    expect(result.clusters[1]!.normalizedScore).toBe(0);
  });

  it('returns zero population values when no clusters are eligible', () => {
    const all = [
      assessedCluster(
        {},
        { eligibleForD1: false, tier2Significance: 'monitored', d1WeightMultiplier: 0 },
      ),
      assessedCluster(
        {},
        { eligibleForD1: false, saResonanceBucket: 'out-of-scope', d1WeightMultiplier: 0 },
      ),
    ];
    const result = aggregateD1FromClusters(all);
    expect(result.maxRawScore).toBe(0);
    expect(result.meanNormalizedScore).toBe(0);
    expect(result.clusters.every((c) => c.normalizedScore === 0)).toBe(true);
  });

  it('handles empty cluster list cleanly', () => {
    const result = aggregateD1FromClusters([]);
    expect(result.maxRawScore).toBe(0);
    expect(result.meanNormalizedScore).toBe(0);
    expect(result.clusters).toEqual([]);
  });
});

// ── AC #2, #4, #5: composition + backward compat + weight balancing ─────────

describe('composeD1Inputs — AC #2 non-replacement', () => {
  it('blends both inputs at 50/50 when default weights + pipeline enabled', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const result = composeD1Inputs({
      signalPipelineD1: 0.8,
      backlogItemD1: 0.4,
      config,
    });
    expect(result.composedScore).toBeCloseTo(0.6, 5); // (0.8 × 0.5) + (0.4 × 0.5)
    expect(result.signalPipelineWeightApplied).toBeCloseTo(0.5);
    expect(result.backlogItemWeightApplied).toBeCloseTo(0.5);
    expect(result.pipelineBypass).toBe(false);
  });

  it('audits per-branch contribution amounts', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const result = composeD1Inputs({
      signalPipelineD1: 0.6,
      backlogItemD1: 0.2,
      config,
    });
    expect(result.signalPipelineContribution).toBeCloseTo(0.3, 5);
    expect(result.backlogItemContribution).toBeCloseTo(0.1, 5);
  });
});

describe('composeD1Inputs — AC #4 backward compat (pipeline disabled)', () => {
  it('bypasses pipeline when config.enabled === false', () => {
    const result = composeD1Inputs({
      signalPipelineD1: 0.9,
      backlogItemD1: 0.3,
      config: DEFAULT_SIGNAL_INGESTION_CONFIG, // enabled: false
    });
    expect(result.composedScore).toBeCloseTo(0.3, 5);
    expect(result.pipelineBypass).toBe(true);
    expect(result.signalPipelineWeightApplied).toBe(0);
    expect(result.backlogItemWeightApplied).toBe(1);
  });

  it('bypasses pipeline when no signalPipelineD1 provided (even if enabled)', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const result = composeD1Inputs({ backlogItemD1: 0.5, config });
    expect(result.composedScore).toBeCloseTo(0.5, 5);
    expect(result.pipelineBypass).toBe(true);
  });

  it('returns 0 when both inputs are absent and pipeline disabled', () => {
    const result = composeD1Inputs({});
    expect(result.composedScore).toBe(0);
    expect(result.pipelineBypass).toBe(true);
  });

  it('treats missing backlogItemD1 as 0 in bypass path', () => {
    const result = composeD1Inputs({ signalPipelineD1: 0.9 }); // pipeline disabled by default
    expect(result.composedScore).toBe(0);
    expect(result.pipelineBypass).toBe(true);
  });

  it('clamps result to [0, 1]', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    // Pathological input — backlog at 1.5 (out-of-range upstream bug)
    const result = composeD1Inputs({ signalPipelineD1: 0.5, backlogItemD1: 1.5, config });
    expect(result.composedScore).toBeLessThanOrEqual(1);
    expect(result.composedScore).toBeGreaterThanOrEqual(0);
  });
});

describe('composeD1Inputs — AC #5 weight balancing', () => {
  it('honours custom weights (pipeline-heavy)', () => {
    const config: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true,
      d1Composition: { signalPipelineWeight: 0.8, backlogItemWeight: 0.2 },
    };
    const result = composeD1Inputs({
      signalPipelineD1: 0.5,
      backlogItemD1: 0.5,
      config,
    });
    expect(result.composedScore).toBeCloseTo(0.5, 5);
    expect(result.signalPipelineWeightApplied).toBeCloseTo(0.8);
    expect(result.backlogItemWeightApplied).toBeCloseTo(0.2);
  });

  it('normalises non-unit-sum weights (e.g. {1, 3} → {0.25, 0.75})', () => {
    const config: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true,
      d1Composition: { signalPipelineWeight: 1, backlogItemWeight: 3 },
    };
    const result = composeD1Inputs({
      signalPipelineD1: 0.8,
      backlogItemD1: 0.4,
      config,
    });
    // 0.8 × 0.25 + 0.4 × 0.75 = 0.2 + 0.3 = 0.5
    expect(result.composedScore).toBeCloseTo(0.5, 5);
    expect(result.signalPipelineWeightApplied).toBeCloseTo(0.25);
    expect(result.backlogItemWeightApplied).toBeCloseTo(0.75);
  });

  it('falls back to 50/50 when both weights are 0 (degenerate config)', () => {
    const config: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true,
      d1Composition: { signalPipelineWeight: 0, backlogItemWeight: 0 },
    };
    const result = composeD1Inputs({
      signalPipelineD1: 0.8,
      backlogItemD1: 0.2,
      config,
    });
    expect(result.signalPipelineWeightApplied).toBeCloseTo(0.5);
    expect(result.backlogItemWeightApplied).toBeCloseTo(0.5);
    expect(result.composedScore).toBeCloseTo(0.5, 5);
  });
});

// ── AC #3: PPA admission integration via demandSignal enrichment ────────────

describe('enrichDemandSignalFromClusters — AC #3 PPA Triad integration', () => {
  const matcherById: ClusterMatcher = (itemKey, aggregated) =>
    aggregated.clusters.find((c) => c.clusterId === itemKey);

  it('overlays composed score on PriorityInput.demandSignal', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const aggregated = aggregateD1FromClusters([assessedCluster({ clusterId: 'cluster:hot' })]);
    const result = enrichDemandSignalFromClusters({
      priorityInput: { demandSignal: 0.2, customerRequestCount: 5 },
      itemKey: 'cluster:hot',
      aggregated,
      matcher: matcherById,
      config,
    });

    // Matched cluster normalises to 1.0 (only eligible cluster)
    // Composed: 1.0 × 0.5 + 0.2 × 0.5 = 0.6
    expect(result.enriched.demandSignal).toBeCloseTo(0.6, 5);
    expect(result.enriched.customerRequestCount).toBe(5); // unrelated fields preserved
    expect(result.matchedCluster?.clusterId).toBe('cluster:hot');
    expect(result.composition.pipelineBypass).toBe(false);
  });

  it('preserves original demandSignal when matcher finds no cluster', () => {
    const config: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const aggregated = aggregateD1FromClusters([assessedCluster({ clusterId: 'cluster:x' })]);
    const result = enrichDemandSignalFromClusters({
      priorityInput: { demandSignal: 0.4 },
      itemKey: 'no-match',
      aggregated,
      matcher: matcherById,
      config,
    });

    // No pipeline contribution → bypass branch
    expect(result.enriched.demandSignal).toBeCloseTo(0.4, 5);
    expect(result.matchedCluster).toBeUndefined();
    expect(result.composition.pipelineBypass).toBe(true);
  });

  it('does not mutate the input object', () => {
    const original = { demandSignal: 0.3, customerRequestCount: 2 };
    const aggregated = aggregateD1FromClusters([assessedCluster({ clusterId: 'cluster:foo' })]);
    enrichDemandSignalFromClusters({
      priorityInput: original,
      itemKey: 'cluster:foo',
      aggregated,
      matcher: matcherById,
      config: { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true },
    });
    expect(original.demandSignal).toBe(0.3);
    expect(original.customerRequestCount).toBe(2);
  });

  it('AC #4 backward compat — pipeline disabled returns input demandSignal unchanged', () => {
    const aggregated = aggregateD1FromClusters([assessedCluster({ clusterId: 'cluster:y' })]);
    const result = enrichDemandSignalFromClusters({
      priorityInput: { demandSignal: 0.7 },
      itemKey: 'cluster:y',
      aggregated,
      matcher: matcherById,
      // default config has enabled: false
    });
    expect(result.enriched.demandSignal).toBeCloseTo(0.7, 5);
    expect(result.composition.pipelineBypass).toBe(true);
  });
});

// ── AC #6 (AISDLC-433): Quarantined signals are excluded from D1(cluster) ───

describe('computeClusterD1 — AISDLC-433 quarantine exclusion', () => {
  const asOf = new Date('2026-05-20T12:00:00.000Z');
  const oneDayMs = 24 * 60 * 60 * 1000;

  it('excludes quarantined signals from cluster scoring (AC #6)', () => {
    const store = new InMemoryQuarantineStore();
    const memberClean = clusterMember('enterprise', 'strong', 0.9, 1, 'sig-clean');
    const memberDirty = clusterMember('enterprise', 'strong', 0.9, 1, 'sig-dirty');
    store.quarantine({
      sourceId: 'sig-dirty',
      adapterSource: 'source-a',
      decisionId: 'flood-1',
      quarantinedAt: asOf,
      expiresAt: new Date(asOf.getTime() + oneDayMs),
      reason: 'z-score 4.0σ',
    });

    const assessment = assessedCluster({
      clusterId: 'cluster:mixed',
      members: [memberClean, memberDirty],
    });

    // Without store → both members contribute.
    const withoutStore = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG);

    // With store → only `memberClean` contributes.
    const withStore = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG, {
      quarantineStore: store,
      asOf,
    });

    expect(withStore.rawScore).toBeLessThan(withoutStore.rawScore);
    expect(withStore.rawScore).toBeCloseTo(withoutStore.rawScore / 2, 5);
  });

  it('all-quarantined cluster scores 0 even though eligibleForD1=true', () => {
    const store = new InMemoryQuarantineStore();
    const m1 = clusterMember('enterprise', 'strong', 0.9, 1, 'q1');
    const m2 = clusterMember('mid', 'partial', 0.8, 1, 'q2');
    for (const id of ['q1', 'q2']) {
      store.quarantine({
        sourceId: id,
        adapterSource: 'source-a',
        decisionId: 'flood-2',
        quarantinedAt: asOf,
        expiresAt: new Date(asOf.getTime() + oneDayMs),
        reason: 'z-score 5σ',
      });
    }

    const assessment = assessedCluster({
      clusterId: 'cluster:all-quarantined',
      members: [m1, m2],
    });

    const result = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG, {
      quarantineStore: store,
      asOf,
    });
    expect(result.rawScore).toBe(0);
    // `eligible` mirrors the significance gate, not the quarantine state —
    // quarantine is a per-member filter, not a cluster-level gate.
    expect(result.eligible).toBe(true);
  });

  it('aggregateD1FromClusters passes quarantineStore through to per-cluster scoring', () => {
    const store = new InMemoryQuarantineStore();
    const m1 = clusterMember('enterprise', 'strong', 0.9, 1, 'all-q');
    store.quarantine({
      sourceId: 'all-q',
      adapterSource: 'source-a',
      decisionId: 'flood-3',
      quarantinedAt: asOf,
      expiresAt: new Date(asOf.getTime() + oneDayMs),
      reason: 'z-score 6σ',
    });
    const assessment = assessedCluster({
      clusterId: 'cluster:all-q',
      members: [m1],
    });
    const aggregated = aggregateD1FromClusters([assessment], DEFAULT_SIGNAL_INGESTION_CONFIG, {
      quarantineStore: store,
      asOf,
    });
    expect(aggregated.clusters[0]!.rawScore).toBe(0);
  });

  it('quarantine auto-expiry releases signals to D1 candidacy', () => {
    const store = new InMemoryQuarantineStore();
    const m = clusterMember('enterprise', 'strong', 0.9, 1, 'expiry-test');
    store.quarantine({
      sourceId: 'expiry-test',
      adapterSource: 'source-a',
      decisionId: 'flood-exp',
      quarantinedAt: asOf,
      expiresAt: new Date(asOf.getTime() + oneDayMs),
      reason: 'z-score 4σ',
    });
    const assessment = assessedCluster({
      clusterId: 'cluster:expiry',
      members: [m],
    });
    // Inside quarantine window → contributes 0.
    expect(
      computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG, {
        quarantineStore: store,
        asOf,
      }).rawScore,
    ).toBe(0);
    // After expiry → contributes again.
    const after = new Date(asOf.getTime() + oneDayMs + 1000);
    const released = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG, {
      quarantineStore: store,
      asOf: after,
    });
    expect(released.rawScore).toBeGreaterThan(0);
  });

  it('omitting quarantineStore preserves pre-AISDLC-433 behaviour (back-compat)', () => {
    const assessment = assessedCluster();
    const baseline = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG);
    const withEmptyOptions = computeClusterD1(assessment, DEFAULT_SIGNAL_INGESTION_CONFIG, {});
    expect(withEmptyOptions.rawScore).toBe(baseline.rawScore);
  });
});
