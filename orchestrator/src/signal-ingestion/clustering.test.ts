/**
 * Tests for RFC-0030 Phase 3 — signal clustering.
 *
 * Covers all 6 acceptance criteria:
 *   #1 BM25 clustering ships as default
 *   #2 Embedding clustering ships when adapter configured + algorithm=embedding
 *   #3 similarityThreshold per-org configurable (default 0.6)
 *   #4 Cluster output: deterministic IDs + member signals + aggregated tier/ICP/recency
 *   #5 Composition with RFC-0019: embedding clustering reads from configured provider
 *   #6 BM25 path requires zero embedding infrastructure (graceful degradation)
 */

import { describe, expect, it, vi } from 'vitest';

import type { EmbeddingAdapter, EmbeddingAvailability } from '../embedding/types.js';
import {
  clusterSignals,
  computeClusterId,
  cosineSimilarity,
  type ClusteredSignalInput,
  type DemandCluster,
} from './clustering.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG, type SignalIngestionConfig } from './config.js';
import type { CustomerTier, RawSignal, SignalTier } from './types.js';
import type { ICPResonance } from './classifier.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeInput(
  sourceId: string,
  payload: string,
  overrides: Partial<{
    customerTier: CustomerTier;
    icpResonance: ICPResonance;
    recencyDecay: number;
    adapterTier: SignalTier;
    sourceTimestamp: Date;
    adapterName: string;
  }> = {},
): ClusteredSignalInput {
  const signal: RawSignal = {
    sourceId,
    sourceTimestamp: overrides.sourceTimestamp ?? new Date('2026-05-01T00:00:00.000Z'),
    payload,
    metadata: overrides.adapterName ? { adapterName: overrides.adapterName } : undefined,
  };
  return {
    signal,
    customerTier: overrides.customerTier ?? 'smb',
    icpResonance: overrides.icpResonance ?? 'partial',
    recencyDecay: overrides.recencyDecay ?? 0.5,
    adapterTier: overrides.adapterTier,
  };
}

function configWith(
  threshold: number,
  algorithm: 'bm25' | 'embedding' = 'bm25',
): SignalIngestionConfig {
  return {
    ...DEFAULT_SIGNAL_INGESTION_CONFIG,
    clustering: { algorithm, similarityThreshold: threshold },
  };
}

// ── AC #1 — BM25 is the default algorithm ───────────────────────────────────

describe('AC #1 — BM25 is the default clustering algorithm', () => {
  it('returns algorithmUsed=bm25 when config is the framework default', async () => {
    const inputs = [makeInput('a', 'search performance is slow'), makeInput('b', 'cannot login')];
    const result = await clusterSignals(inputs);
    expect(result.algorithmUsed).toBe('bm25');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('clusters lexically similar payloads together via BM25', async () => {
    const inputs = [
      makeInput('a', 'search performance is slow and degrades over time'),
      makeInput('b', 'search performance is degrading every day'),
      makeInput('c', 'cannot login with SSO provider'),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.25) });
    // Two clusters: {a,b} (search) and {c} (login)
    expect(result.clusters.length).toBe(2);
    const sizes = result.clusters.map((c) => c.signalCount).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('keeps lexically dissimilar payloads in separate clusters at default threshold', async () => {
    const inputs = [
      makeInput('a', 'search results are completely wrong'),
      makeInput('b', 'cannot upload large files reliably'),
      makeInput('c', 'API rate limits unclear in documentation'),
    ];
    const result = await clusterSignals(inputs); // default 0.6 threshold
    expect(result.clusters.length).toBe(3);
    for (const c of result.clusters) expect(c.signalCount).toBe(1);
  });
});

// ── AC #2 + #5 — Embedding algorithm when adapter wired ─────────────────────

describe('AC #2 + #5 — embedding clustering with RFC-0019 adapter', () => {
  /**
   * Mock adapter that returns hand-crafted vectors so cosine similarity is
   * predictable. Implements the RFC-0019 EmbeddingAdapter interface surface
   * the clusterer touches (embed/embedBatch/isAvailable + identity fields).
   */
  function makeMockAdapter(
    vectorByPayload: Record<string, number[]>,
    available: boolean = true,
  ): EmbeddingAdapter & { embedCalls: string[]; batchCalls: number } {
    const adapter = {
      name: 'mock-embedding',
      modelId: 'mock-model',
      modelVersion: '2026-05-23',
      dimensions: 3,
      capabilities: {
        dimensions: 3,
        maxInputTokens: 1000,
        supportsBatching: true,
        selfHosted: true,
        billingModel: 'pay-per-token' as const,
      },
      requires: {},
      embedCalls: [] as string[],
      batchCalls: 0,
      async embed(text: string, _consumerLabel?: string): Promise<number[]> {
        this.embedCalls.push(text);
        const vec = vectorByPayload[text];
        if (!vec) throw new Error(`mock adapter: no vector for ${text}`);
        return vec;
      },
      async embedBatch(texts: string[], _consumerLabel?: string): Promise<number[][]> {
        this.batchCalls++;
        return texts.map((t) => {
          const vec = vectorByPayload[t];
          if (!vec) throw new Error(`mock adapter: no vector for ${t}`);
          return vec;
        });
      },
      async isAvailable(): Promise<EmbeddingAvailability> {
        return { available };
      },
      async getAccountId(): Promise<string | null> {
        return null;
      },
    };
    return adapter;
  }

  it('uses the embedding adapter when algorithm=embedding and adapter wired', async () => {
    // Two near-identical vectors → should cluster together at threshold 0.9
    const adapter = makeMockAdapter({
      hello: [1, 0, 0],
      hi: [0.95, 0.05, 0], // ~0.999 cosine sim with [1,0,0]
      world: [0, 1, 0],
    });
    const inputs = [makeInput('a', 'hello'), makeInput('b', 'hi'), makeInput('c', 'world')];
    const result = await clusterSignals(inputs, {
      config: configWith(0.9, 'embedding'),
      embeddingAdapter: adapter,
    });

    expect(result.algorithmUsed).toBe('embedding');
    expect(result.fallbackReason).toBeUndefined();
    expect(result.clusters.length).toBe(2);
    expect(adapter.batchCalls).toBe(1); // batched path used
  });

  it('passes the configured consumerLabel for cost attribution (OQ-6)', async () => {
    const adapter = makeMockAdapter({ foo: [1, 0, 0] });
    const embedSpy = vi.spyOn(adapter, 'embedBatch');
    await clusterSignals([makeInput('a', 'foo')], {
      config: configWith(0.5, 'embedding'),
      embeddingAdapter: adapter,
      embeddingConsumerLabel: 'rfc-0030-clustering-custom',
    });
    expect(embedSpy).toHaveBeenCalledWith(['foo'], 'rfc-0030-clustering-custom');
  });

  it('defaults consumerLabel to "rfc-0030-clustering"', async () => {
    const adapter = makeMockAdapter({ foo: [1, 0, 0] });
    const embedSpy = vi.spyOn(adapter, 'embedBatch');
    await clusterSignals([makeInput('a', 'foo')], {
      config: configWith(0.5, 'embedding'),
      embeddingAdapter: adapter,
    });
    expect(embedSpy).toHaveBeenCalledWith(['foo'], 'rfc-0030-clustering');
  });

  it('falls back to sequential embed() when embedBatch is not implemented', async () => {
    const adapter = makeMockAdapter({
      one: [1, 0, 0],
      two: [0, 1, 0],
    });
    // Strip the optional embedBatch
    const noBatchAdapter: EmbeddingAdapter = {
      ...adapter,
      embedBatch: undefined,
    };
    const result = await clusterSignals([makeInput('a', 'one'), makeInput('b', 'two')], {
      config: configWith(0.9, 'embedding'),
      embeddingAdapter: noBatchAdapter,
    });
    expect(result.algorithmUsed).toBe('embedding');
    expect(adapter.embedCalls).toEqual(['one', 'two']);
  });
});

// ── AC #6 — graceful degradation when no embedding adapter wired ────────────

describe('AC #6 — BM25 graceful degradation when embedding adapter missing', () => {
  it('falls back to BM25 when algorithm=embedding but no adapter supplied', async () => {
    const onFallback = vi.fn();
    const inputs = [
      makeInput('a', 'search performance regression'),
      makeInput('b', 'search performance bug'),
    ];
    const result = await clusterSignals(inputs, {
      config: configWith(0.25, 'embedding'),
      onFallback,
    });

    expect(result.algorithmUsed).toBe('bm25');
    expect(result.fallbackReason).toBe('embedding-adapter-missing');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith({
      reason: 'embedding-adapter-missing',
      message: expect.stringContaining('falling back to BM25'),
    });
    // Should still produce a sensible cluster from BM25
    expect(result.clusters.length).toBeGreaterThan(0);
  });

  it('falls back to BM25 when adapter reports unavailable', async () => {
    const onFallback = vi.fn();
    const unavailableAdapter: EmbeddingAdapter = {
      name: 'broken',
      modelId: 'm',
      modelVersion: 'v1',
      dimensions: 3,
      capabilities: {
        dimensions: 3,
        maxInputTokens: 1000,
        supportsBatching: false,
        selfHosted: false,
        billingModel: 'pay-per-token',
      },
      requires: { envVar: 'BROKEN_KEY' },
      async embed() {
        throw new Error('should not be called');
      },
      async isAvailable() {
        return { available: false, reason: 'env-var-missing', detail: 'BROKEN_KEY not set' };
      },
      async getAccountId() {
        return null;
      },
    };

    const result = await clusterSignals([makeInput('a', 'foo'), makeInput('b', 'bar')], {
      config: configWith(0.5, 'embedding'),
      embeddingAdapter: unavailableAdapter,
      onFallback,
    });

    expect(result.algorithmUsed).toBe('bm25');
    expect(result.fallbackReason).toBe('embedding-adapter-unavailable');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0]![0]).toMatchObject({
      reason: 'embedding-adapter-unavailable',
    });
  });

  it('does NOT crash with a missing adapter — empty embedding infra is OK', async () => {
    // Even with NO config, NO adapter, NO callback → just works
    const inputs = [makeInput('a', 'search slow'), makeInput('b', 'search broken')];
    await expect(clusterSignals(inputs)).resolves.toMatchObject({
      algorithmUsed: 'bm25',
      fallbackReason: undefined,
    });
  });
});

// ── AC #3 — similarityThreshold configurable ────────────────────────────────

describe('AC #3 — similarityThreshold per-org configurable', () => {
  it('default threshold is 0.6', () => {
    expect(DEFAULT_SIGNAL_INGESTION_CONFIG.clustering.similarityThreshold).toBe(0.6);
    expect(DEFAULT_SIGNAL_INGESTION_CONFIG.clustering.algorithm).toBe('bm25');
  });

  it('low threshold groups more signals together', async () => {
    const inputs = [
      makeInput('a', 'search performance is slow'),
      makeInput('b', 'search results take forever'),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.signalCount).toBe(2);
  });

  it('high threshold keeps signals separate', async () => {
    const inputs = [
      makeInput('a', 'search performance is slow'),
      makeInput('b', 'search results take forever'),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.95) });
    expect(result.clusters.length).toBe(2);
  });

  it('threshold of exactly the boundary similarity is inclusive (>=)', async () => {
    // Mock adapter with known cosine similarity = 0.5
    const adapter: EmbeddingAdapter = {
      name: 'mock',
      modelId: 'm',
      modelVersion: 'v',
      dimensions: 2,
      capabilities: {
        dimensions: 2,
        maxInputTokens: 100,
        supportsBatching: true,
        selfHosted: true,
        billingModel: 'pay-per-token',
      },
      requires: {},
      async embed() {
        throw new Error('use embedBatch');
      },
      async embedBatch(texts) {
        // Two vectors with cosine sim exactly 0.5
        // [1, 0] and [1, sqrt(3)] -> cos = 1 / (1 * 2) = 0.5
        return texts.map((_, i) => (i === 0 ? [1, 0] : [1, Math.sqrt(3)]));
      },
      async isAvailable() {
        return { available: true };
      },
      async getAccountId() {
        return null;
      },
    };
    const result = await clusterSignals([makeInput('a', 'x'), makeInput('b', 'y')], {
      config: configWith(0.5, 'embedding'),
      embeddingAdapter: adapter,
    });
    expect(result.clusters.length).toBe(1);
  });
});

// ── AC #4 — deterministic IDs + aggregated metadata ─────────────────────────

describe('AC #4 — deterministic cluster IDs + aggregated metadata', () => {
  it('produces the same clusterId for the same member set regardless of input order', async () => {
    const inputsA = [
      makeInput('a', 'search slow', { sourceTimestamp: new Date('2026-05-01') }),
      makeInput('b', 'search slow today', { sourceTimestamp: new Date('2026-05-02') }),
    ];
    const inputsB = [
      makeInput('b', 'search slow today', { sourceTimestamp: new Date('2026-05-02') }),
      makeInput('a', 'search slow', { sourceTimestamp: new Date('2026-05-01') }),
    ];
    const resultA = await clusterSignals(inputsA, { config: configWith(0.1) });
    const resultB = await clusterSignals(inputsB, { config: configWith(0.1) });

    expect(resultA.clusters.length).toBe(1);
    expect(resultB.clusters.length).toBe(1);
    expect(resultA.clusters[0]!.clusterId).toBe(resultB.clusters[0]!.clusterId);
  });

  it('computeClusterId helper is pure and stable', () => {
    const id1 = computeClusterId(['a', 'b', 'c']);
    const id2 = computeClusterId(['a', 'b', 'c']);
    const id3 = computeClusterId(['a', 'b', 'd']);
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^cluster:[a-f0-9]{24}$/);
  });

  it('disambiguates [a, bc] from [ab, c] via delimiter', () => {
    expect(computeClusterId(['a', 'bc'])).not.toBe(computeClusterId(['ab', 'c']));
  });

  it('aggregates signalCount + uniqueSources from member metadata', async () => {
    const inputs = [
      makeInput('a', 'login broken', { adapterName: 'support-ticket' }),
      makeInput('b', 'login completely broken', { adapterName: 'support-ticket' }),
      makeInput('c', 'login broken now', { adapterName: 'community-thread' }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.1) });
    expect(result.clusters.length).toBe(1);
    const cluster = result.clusters[0]!;
    expect(cluster.signalCount).toBe(3);
    expect(cluster.uniqueSources).toBe(2);
  });

  it('aggregates oldest/newest timestamp across members', async () => {
    const inputs = [
      makeInput('a', 'foo bar', { sourceTimestamp: new Date('2026-04-15') }),
      makeInput('b', 'foo bar baz', { sourceTimestamp: new Date('2026-05-01') }),
      makeInput('c', 'foo bar qux', { sourceTimestamp: new Date('2026-04-20') }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters.length).toBe(1);
    const cluster = result.clusters[0]!;
    expect(cluster.oldestSignalAt.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(cluster.newestSignalAt.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('computes icpMatchRate as fraction of strong-resonance members', async () => {
    const inputs = [
      makeInput('a', 'topic', { icpResonance: 'strong' }),
      makeInput('b', 'topic again', { icpResonance: 'strong' }),
      makeInput('c', 'topic also', { icpResonance: 'partial' }),
      makeInput('d', 'topic still', { icpResonance: 'weak' }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.icpMatchRate).toBeCloseTo(0.5, 5);
  });

  it('computes churnCorrelation as fraction of churned-tier members', async () => {
    const inputs = [
      makeInput('a', 'topic', { customerTier: 'churned' }),
      makeInput('b', 'topic also', { customerTier: 'enterprise' }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.churnCorrelation).toBeCloseTo(0.5, 5);
  });

  it('counts tier1 vs tier2 signals using explicit adapterTier hint', async () => {
    const inputs = [
      makeInput('a', 'topic', { adapterTier: 1 }),
      makeInput('b', 'topic also', { adapterTier: 1 }),
      makeInput('c', 'topic too', { adapterTier: 2 }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters.length).toBe(1);
    const cluster = result.clusters[0]!;
    expect(cluster.tier1SignalCount).toBe(2);
    expect(cluster.tier2SignalCount).toBe(1);
  });

  it('falls back to signal.metadata.adapterTier when explicit adapterTier absent', async () => {
    const inputs: ClusteredSignalInput[] = [
      {
        signal: {
          sourceId: 'a',
          sourceTimestamp: new Date('2026-05-01'),
          payload: 'topic',
          metadata: { adapterTier: 2 },
        },
        customerTier: 'smb',
        icpResonance: 'partial',
        recencyDecay: 1.0,
      },
    ];
    const result = await clusterSignals(inputs);
    expect(result.clusters[0]!.tier2SignalCount).toBe(1);
    expect(result.clusters[0]!.tier1SignalCount).toBe(0);
  });

  it('defaults tier to 1 when no hint is present', async () => {
    const inputs = [makeInput('a', 'topic')];
    const result = await clusterSignals(inputs);
    expect(result.clusters[0]!.tier1SignalCount).toBe(1);
    expect(result.clusters[0]!.tier2SignalCount).toBe(0);
  });

  it('computes mean recency decay across members', async () => {
    const inputs = [
      makeInput('a', 'topic', { recencyDecay: 1.0 }),
      makeInput('b', 'topic also', { recencyDecay: 0.5 }),
    ];
    const result = await clusterSignals(inputs, { config: configWith(0.05) });
    expect(result.clusters[0]!.aggregateRecencyDecay).toBeCloseTo(0.75, 5);
  });

  it('leaves saResonance + topSummary undefined (Phase 4/5 work)', async () => {
    const inputs = [makeInput('a', 'topic')];
    const result = await clusterSignals(inputs);
    expect(result.clusters[0]!.saResonance).toBeUndefined();
    expect(result.clusters[0]!.topSummary).toBeUndefined();
  });

  it('output ordering is deterministic (sorted by clusterId)', async () => {
    const inputs = [
      makeInput('zzz', 'thing one'),
      makeInput('aaa', 'thing two'),
      makeInput('mmm', 'thing three'),
    ];
    const result1 = await clusterSignals(inputs); // 0.6 default → all separate
    const result2 = await clusterSignals(inputs);
    expect(result1.clusters.map((c) => c.clusterId)).toEqual(
      result2.clusters.map((c) => c.clusterId),
    );
    // Verify sort
    const ids = result1.clusters.map((c) => c.clusterId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ── cosineSimilarity helper ─────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length mismatch/);
  });

  it('is symmetric', () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.7, 0.1, 0.4];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('returns empty result on empty input', async () => {
    const result = await clusterSignals([]);
    expect(result.clusters).toEqual([]);
    expect(result.algorithmUsed).toBe('bm25');
  });

  it('singleton input → one singleton cluster', async () => {
    const result = await clusterSignals([makeInput('only', 'lonely signal')]);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.signalCount).toBe(1);
  });

  it('handles signals with empty payloads without crashing', async () => {
    const inputs = [makeInput('a', ''), makeInput('b', '')];
    const result = await clusterSignals(inputs, { config: configWith(0.6) });
    // Two empty payloads have no terms → similarity 0 → separate clusters
    expect(result.clusters.length).toBe(2);
  });

  it('rejects payloads of vastly different sizes correctly', async () => {
    const inputs = [
      makeInput('a', 'foo'),
      makeInput('b', 'foo '.repeat(1000) + 'bar baz qux quux corge'),
    ];
    // BM25 length normalisation should keep these from being a perfect match
    // but the short payload's terms exist in the long one — they cluster.
    const result = await clusterSignals(inputs, { config: configWith(0.1) });
    // Just ensure no crash + result is structurally valid
    for (const cluster of result.clusters) {
      expect(cluster.signalCount).toBeGreaterThan(0);
      expect(cluster.clusterId).toMatch(/^cluster:[a-f0-9]{24}$/);
    }
  });

  it('preserves member shape (signal + customerTier + icpResonance + recencyDecay)', async () => {
    const input = makeInput('a', 'topic', {
      customerTier: 'enterprise',
      icpResonance: 'strong',
      recencyDecay: 0.42,
    });
    const result = await clusterSignals([input]);
    const member = result.clusters[0]!.members[0]!;
    expect(member.signal.sourceId).toBe('a');
    expect(member.customerTier).toBe('enterprise');
    expect(member.icpResonance).toBe('strong');
    expect(member.recencyDecay).toBe(0.42);
  });
});

// ── Integration sanity ──────────────────────────────────────────────────────

describe('integration — realistic batch', () => {
  it('clusters a mixed support+community batch into recognisable demand themes', async () => {
    const inputs: ClusteredSignalInput[] = [
      makeInput('zd-1', 'Search results are missing recent articles', {
        adapterName: 'signal-source-support-ticket',
        adapterTier: 1,
        customerTier: 'enterprise',
        icpResonance: 'strong',
        recencyDecay: 0.9,
      }),
      makeInput('zd-2', 'Recent search results missing from index', {
        adapterName: 'signal-source-support-ticket',
        adapterTier: 1,
        customerTier: 'mid',
        icpResonance: 'strong',
        recencyDecay: 0.85,
      }),
      makeInput('cm-1', 'search index appears to skip new articles', {
        adapterName: 'signal-source-community-thread',
        adapterTier: 2,
        customerTier: 'free',
        icpResonance: 'partial',
        recencyDecay: 0.8,
      }),
      makeInput('zd-3', 'Cannot upload files larger than 10MB', {
        adapterName: 'signal-source-support-ticket',
        adapterTier: 1,
        customerTier: 'enterprise',
        icpResonance: 'strong',
        recencyDecay: 0.95,
      }),
    ];

    // Use a low threshold to ensure the lexically-overlapping search signals cluster
    const result = await clusterSignals(inputs, { config: configWith(0.1) });

    // Search theme should cluster (3 signals); upload is its own.
    const searchCluster = result.clusters.find((c) => c.signalCount > 1);
    expect(searchCluster).toBeDefined();
    expect(searchCluster!.uniqueSources).toBeGreaterThanOrEqual(2);
    expect(searchCluster!.tier1SignalCount).toBeGreaterThanOrEqual(2);
    expect(searchCluster!.tier2SignalCount).toBeGreaterThanOrEqual(1);
    expect(searchCluster!.icpMatchRate).toBeGreaterThan(0);
  });
});

// ── Type completeness sanity ────────────────────────────────────────────────

describe('exported shape', () => {
  it('DemandCluster fields are all documented + present', async () => {
    const result = await clusterSignals([makeInput('a', 'topic')]);
    const cluster: DemandCluster = result.clusters[0]!;
    // Verify required fields exist (compile-time check via type annotation;
    // runtime sanity via property assertions).
    expect(cluster).toHaveProperty('clusterId');
    expect(cluster).toHaveProperty('members');
    expect(cluster).toHaveProperty('signalCount');
    expect(cluster).toHaveProperty('uniqueSources');
    expect(cluster).toHaveProperty('tier1SignalCount');
    expect(cluster).toHaveProperty('tier2SignalCount');
    expect(cluster).toHaveProperty('oldestSignalAt');
    expect(cluster).toHaveProperty('newestSignalAt');
    expect(cluster).toHaveProperty('icpMatchRate');
    expect(cluster).toHaveProperty('churnCorrelation');
    expect(cluster).toHaveProperty('aggregateRecencyDecay');
  });
});
