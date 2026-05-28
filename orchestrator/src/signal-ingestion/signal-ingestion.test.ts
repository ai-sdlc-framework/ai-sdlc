import { describe, expect, it } from 'vitest';
import {
  AdapterCredentialInvalid,
  CommunityThreadSignalSourceAdapter,
  ManualSignalIncomplete,
  ManualSignalSourceAdapter,
  SignalSourceUnavailable,
  SignalSourceRegistry,
  SupportTicketSignalSourceAdapter,
  UnknownSignalSource,
  aggregateD1FromClusters,
  assessClusterSignificance,
  classifySignals,
  clusterSignals,
  createDefaultSignalSourceRegistry,
  enrichDemandSignalFromClusters,
  fetchSignalsFromAvailableAdapters,
  getSignalSourceAdapter,
  type ClusterMatcher,
  type ClusteredSignalInput,
  type RawSignal,
  type SignalIngestionConfig,
} from './index.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG } from './config.js';

const since = new Date('2026-01-01T00:00:00.000Z');

function signal(sourceId: string, sourceTimestamp = '2026-01-02T00:00:00.000Z'): RawSignal {
  return {
    sourceId,
    sourceTimestamp: new Date(sourceTimestamp),
    payload: `payload ${sourceId}`,
  };
}

describe('SignalSourceRegistry', () => {
  it('registers and resolves adapters by name', async () => {
    const registry = new SignalSourceRegistry();
    const support = new SupportTicketSignalSourceAdapter();
    registry.register(support);

    expect(registry.has('signal-source-support-ticket')).toBe(true);
    expect(registry.list()).toEqual(['signal-source-support-ticket']);
    await expect(getSignalSourceAdapter(registry, 'signal-source-support-ticket')).resolves.toBe(
      support,
    );
  });

  it('throws a structured error for unknown adapters', () => {
    const registry = new SignalSourceRegistry();
    expect(() => registry.get('missing')).toThrow(UnknownSignalSource);
  });

  it('rejects unavailable registered adapters', async () => {
    const registry = new SignalSourceRegistry();
    registry.register(new SupportTicketSignalSourceAdapter({ available: false }));

    await expect(getSignalSourceAdapter(registry, 'signal-source-support-ticket')).rejects.toThrow(
      SignalSourceUnavailable,
    );
  });

  it('creates a default registry with all v1 env-var-based adapters (RFC-0030 OQ-13.1 v0.3)', () => {
    const registry = createDefaultSignalSourceRegistry();

    expect(registry.list().sort()).toEqual([
      'signal-source-community-thread',
      'signal-source-in-app-feedback',
      'signal-source-manual',
      'signal-source-support-ticket',
    ]);
  });
});

describe('default signal source adapters', () => {
  it('support-ticket adapter is Tier 1 and filters by since timestamp', async () => {
    const adapter = new SupportTicketSignalSourceAdapter({
      signals: [signal('old', '2025-12-31T00:00:00.000Z'), signal('new')],
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.defaultTier).toBe(1);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([signal('new')]);
  });

  it('community-thread adapter is Tier 2 and filters by since timestamp', async () => {
    const adapter = new CommunityThreadSignalSourceAdapter({
      signals: [signal('old', '2025-12-31T00:00:00.000Z'), signal('new')],
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.defaultTier).toBe(2);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([signal('new')]);
  });

  it('manual adapter requires attestedBy and fills attestedAt', async () => {
    const adapter = new ManualSignalSourceAdapter();
    const now = new Date('2026-05-16T12:00:00.000Z');

    expect(() => adapter.addSignal(signal('manual-missing-attestation'), now)).toThrow(
      ManualSignalIncomplete,
    );

    const added = adapter.addSignal(
      {
        ...signal('manual'),
        attestedBy: 'operator@example.com',
      },
      now,
    );

    expect(added.attestedAt).toEqual(now);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([added]);
  });

  it('credential failures emit non-blocking decisions and remaining adapters continue', async () => {
    const failing = new SupportTicketSignalSourceAdapter({ credentialInvalid: true });
    const succeeding = new CommunityThreadSignalSourceAdapter({ signals: [signal('community')] });

    const result = await fetchSignalsFromAvailableAdapters([failing, succeeding], since);

    expect(result.signals).toEqual([signal('community')]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-invalid',
        adapter: 'signal-source-support-ticket',
        message: 'Signal source adapter credentials invalid: signal-source-support-ticket',
      },
    ]);
  });

  it('sanitizes credential error details in decisions', async () => {
    class SecretLeakingAdapter extends SupportTicketSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        throw new AdapterCredentialInvalid(
          this.name,
          '401 token=sk-secret Authorization: Bearer abc',
        );
      }
    }

    const result = await fetchSignalsFromAvailableAdapters([new SecretLeakingAdapter()], since);

    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-invalid',
        adapter: 'signal-source-support-ticket',
        message: 'Signal source adapter credentials invalid: signal-source-support-ticket',
      },
    ]);
  });

  it('skips unavailable adapters and continues with available adapters', async () => {
    class ThrowIfFetchedAdapter extends SupportTicketSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        throw new Error('fetchSignals should not run for unavailable adapters');
      }
    }

    const unavailable = new ThrowIfFetchedAdapter({ available: false });
    const available = new CommunityThreadSignalSourceAdapter({ signals: [signal('community')] });

    const result = await fetchSignalsFromAvailableAdapters([unavailable, available], since);

    expect(result.signals).toEqual([signal('community')]);
    expect(result.decisions).toEqual([]);
  });

  it('manual attestation failures emit manual-signal-incomplete decisions', async () => {
    class InvalidManualAdapter extends ManualSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        this.addSignal(signal('manual-missing-attestation'));
        return [];
      }
    }

    const result = await fetchSignalsFromAvailableAdapters([new InvalidManualAdapter()], since);

    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'manual-signal-incomplete',
        adapter: 'signal-source-manual',
        sourceId: 'manual-missing-attestation',
        message: 'Manual signal missing required attestation fields',
      },
    ]);
  });
});

// ── AC #6: end-to-end pipeline → cluster → D1 → admission ─────────────────────

describe('RFC-0030 Phase 5 — end-to-end pipeline → cluster → D1 → admission', () => {
  /**
   * Wires every signal-ingestion phase together:
   *   1. Phase 1: fetch raw signals from in-memory adapters.
   *   2. Phase 2: classifySignals → tier + ICP resonance + recency.
   *   3. Phase 3: clusterSignals (BM25) → DemandCluster[].
   *   4. Phase 4: assessClusterSignificance → SignificanceAssessedCluster[].
   *   5. Phase 5: aggregateD1FromClusters → AggregatedD1Result.
   *   6. RFC-0008 integration: enrichDemandSignalFromClusters → PriorityInput.
   *
   * The test asserts the composed `demandSignal` is the ONLY field the
   * downstream `mapIssueToPriorityInput()` consumes for D1 — the integration
   * surface is intentionally narrow so the existing PPA admission composite
   * (admission-composite.ts) flows through unmodified.
   */
  it('flows from adapter to demandSignal-enriched PriorityInput when pipeline enabled', async () => {
    const config: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true, // explicit opt-in per RFC-0030 §11 default OFF + AC #4
      tier2SignificanceThreshold: {
        ...DEFAULT_SIGNAL_INGESTION_CONFIG.tier2SignificanceThreshold,
        // Test thresholds lowered to keep the e2e fixture self-contained.
        // Production defaults (§11) require minSignalCount=5, minUniqueSources=3,
        // minTier1SignalCount=1, minClusterAgeDays=7. We're testing the
        // pipeline-to-D1 wiring here, not BM25 clustering sensitivity, so the
        // gate is permissive enough for small-fixture clusters to qualify.
        minSignalCount: 1,
        minUniqueSources: 1,
        minTier1SignalCount: 1,
        minClusterAgeDays: 0,
      },
    };

    // Step 1 — fetch (in-memory adapters; deterministic).
    const supportAdapter = new SupportTicketSignalSourceAdapter({
      signals: [
        {
          sourceId: 'support-1',
          sourceTimestamp: new Date('2026-05-15T00:00:00.000Z'),
          customerId: 'enterprise-acme',
          payload: 'auth login failure when SAML callback returns no nonce',
          metadata: { adapterTier: 1, adapterName: 'signal-source-support-ticket' },
        },
        {
          sourceId: 'support-2',
          sourceTimestamp: new Date('2026-05-14T00:00:00.000Z'),
          customerId: 'mid-beta',
          payload: 'auth login failure same nonce missing error code 503',
          metadata: { adapterTier: 1, adapterName: 'signal-source-support-ticket' },
        },
      ],
    });
    const communityAdapter = new CommunityThreadSignalSourceAdapter({
      signals: [
        {
          sourceId: 'community-1',
          sourceTimestamp: new Date('2026-05-13T00:00:00.000Z'),
          customerId: 'smb-gamma',
          payload: 'docs need example for dark mode token override workflow',
          metadata: { adapterTier: 2, adapterName: 'signal-source-community-thread' },
        },
      ],
    });
    const fetched = await fetchSignalsFromAvailableAdapters(
      [supportAdapter, communityAdapter],
      new Date('2026-05-01T00:00:00.000Z'),
    );
    expect(fetched.signals).toHaveLength(3);

    // Step 2 — classify.
    const customerTiers = new Map<string, 'enterprise' | 'mid' | 'smb' | 'free' | 'churned'>([
      ['enterprise-acme', 'enterprise'],
      ['mid-beta', 'mid'],
      ['smb-gamma', 'smb'],
    ]);
    const classification = classifySignals(fetched.signals, {
      asOf: new Date('2026-05-20T00:00:00.000Z'),
      config,
      tierRegistry: { resolve: (id) => customerTiers.get(id) },
      icpSegments: ['auth', 'login', 'dark mode'],
    });
    expect(classification.classified).toHaveLength(3);

    // Step 3 — cluster.
    const clusterInputs: ClusteredSignalInput[] = classification.classified.map((c) => ({
      signal: c.signal,
      customerTier: c.customerTier,
      icpResonance: c.icpResonance,
      recencyDecay: c.recencyDecay,
      adapterTier: c.signal.metadata?.['adapterTier'] === 2 ? 2 : 1,
    }));
    const clusterResult = await clusterSignals(clusterInputs, { config });
    expect(clusterResult.algorithmUsed).toBe('bm25');
    expect(clusterResult.clusters.length).toBeGreaterThan(0);

    // Step 4 — assess significance (force SA to a known value for determinism).
    const withSa = clusterResult.clusters.map((c) => ({ ...c, saResonance: 0.85 }));
    const assessment = assessClusterSignificance(withSa, {
      config,
      asOf: new Date('2026-05-20T00:00:00.000Z'),
    });
    expect(assessment.assessments.length).toBeGreaterThan(0);

    // Step 5 — aggregate per §10 final-line normalisation.
    const aggregated = aggregateD1FromClusters(assessment.assessments, config);
    const eligibleClusters = aggregated.clusters.filter((c) => c.eligible);
    expect(eligibleClusters.length).toBeGreaterThan(0);
    expect(eligibleClusters.some((c) => c.normalizedScore === 1)).toBe(true);
    expect(aggregated.meanNormalizedScore).toBeGreaterThan(0);

    // Step 6 — overlay onto a PriorityInput-shaped object. The integration
    // surface is `PriorityInput.demandSignal`; everything downstream (Sα₁ + Eρ₅
    // admission composite per RFC-0008 §A.6) reads through that single field.
    const matcher: ClusterMatcher = (_itemKey, agg) =>
      agg.clusters.find((c) => c.eligible && c.normalizedScore === 1);
    const priorityInput = { demandSignal: 0.2, customerRequestCount: 1 };
    const enrichment = enrichDemandSignalFromClusters({
      priorityInput,
      itemKey: 'admission-item-A',
      aggregated,
      matcher,
      config,
    });

    // Composed score: pipeline (1.0 normalised) × 0.5 + backlog (0.2) × 0.5 = 0.6
    expect(enrichment.enriched.demandSignal).toBeCloseTo(0.6, 5);
    expect(enrichment.composition.pipelineBypass).toBe(false);
    expect(enrichment.matchedCluster?.normalizedScore).toBe(1);
    expect(priorityInput.demandSignal).toBe(0.2); // input not mutated
  });

  it('AC #4 backward compat — pipeline disabled defaults pass through unchanged', async () => {
    // Same setup as above but DEFAULT_SIGNAL_INGESTION_CONFIG keeps enabled=false.
    const supportAdapter = new SupportTicketSignalSourceAdapter({
      signals: [
        {
          sourceId: 'support-x',
          sourceTimestamp: new Date('2026-05-15T00:00:00.000Z'),
          payload: 'feature request: cli flag for verbose logs',
          metadata: { adapterTier: 1 },
        },
      ],
    });
    const fetched = await fetchSignalsFromAvailableAdapters(
      [supportAdapter],
      new Date('2026-05-01T00:00:00.000Z'),
    );
    const classification = classifySignals(fetched.signals, {
      asOf: new Date('2026-05-20T00:00:00.000Z'),
    });
    const clusterInputs: ClusteredSignalInput[] = classification.classified.map((c) => ({
      signal: c.signal,
      customerTier: c.customerTier,
      icpResonance: c.icpResonance,
      recencyDecay: c.recencyDecay,
      adapterTier: 1,
    }));
    const clusterResult = await clusterSignals(clusterInputs);
    const withSa = clusterResult.clusters.map((c) => ({ ...c, saResonance: 0.9 }));
    const assessment = assessClusterSignificance(withSa, {
      asOf: new Date('2026-05-20T00:00:00.000Z'),
    });
    const aggregated = aggregateD1FromClusters(assessment.assessments);

    // Even though aggregation runs, composition bypasses the pipeline because
    // DEFAULT_SIGNAL_INGESTION_CONFIG.enabled === false. Backlog input passes through unchanged.
    const matcher: ClusterMatcher = (_itemKey, agg) => agg.clusters[0];
    const enrichment = enrichDemandSignalFromClusters({
      priorityInput: { demandSignal: 0.45 },
      itemKey: 'task-y',
      aggregated,
      matcher,
      // omit config → defaults → disabled
    });

    expect(enrichment.enriched.demandSignal).toBeCloseTo(0.45, 5);
    expect(enrichment.composition.pipelineBypass).toBe(true);
  });
});
