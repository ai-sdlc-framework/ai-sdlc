/**
 * Unit tests for RFC-0019 Phase 1 embedding adapter framework.
 *
 * Covers AC#10:
 * - Registry round-trip
 * - Adapter dimension validation
 * - isAvailable() probe behavior
 * - Unknown-provider error path
 * - consumerLabel propagation through to cost-tracker (OQ-6 re-walkthrough)
 * - billingModel field on adapter is correctly read by framework (OQ-7 re-walkthrough)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  EmbeddingAdapter,
  EmbeddingAvailability,
  EmbeddingCapabilities,
  EmbeddingRequires,
  EmbeddingCostRecord,
} from './types.js';
import {
  getEmbeddingAdapter,
  registerEmbeddingAdapter,
  hasEmbeddingAdapter,
  listEmbeddingAdapters,
} from './registry.js';
import {
  UnknownEmbeddingProvider,
  EmbeddingProviderUnavailable,
  EmbeddingDimensionMismatch,
  EmbeddingModelRemoved,
  EmbeddingModelDeprecated,
} from './errors.js';
import { OpenAITextEmbedding3Small } from './adapters/openai-text-embedding-3-small.js';

// ── Stub adapter for registry tests ──────────────────────────────────────────

class StubEmbeddingAdapter implements EmbeddingAdapter {
  readonly name: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly capabilities: EmbeddingCapabilities;
  readonly requires: EmbeddingRequires;

  constructor(name: string, dimensions = 768) {
    this.name = name;
    this.modelId = `stub-model-${name}`;
    this.modelVersion = '1.0.0';
    this.dimensions = dimensions;
    this.capabilities = {
      dimensions,
      maxInputTokens: 512,
      supportsBatching: false,
      selfHosted: true,
      billingModel: 'pay-per-token',
    };
    this.requires = {};
  }

  async isAvailable(): Promise<EmbeddingAvailability> {
    return { available: true };
  }

  async getAccountId(): Promise<string | null> {
    return null;
  }

  async embed(_text: string, _consumerLabel?: string): Promise<number[]> {
    return new Array(this.dimensions).fill(0.1) as number[];
  }
}

// ── Registry tests ────────────────────────────────────────────────────────────

describe('embedding registry', () => {
  it('resolves the built-in openai-text-embedding-3-small adapter', () => {
    const adapter = getEmbeddingAdapter('openai-text-embedding-3-small');
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe('openai-text-embedding-3-small');
  });

  it('throws UnknownEmbeddingProvider for an unregistered name', () => {
    expect(() => getEmbeddingAdapter('nonexistent-adapter-xyz')).toThrow(UnknownEmbeddingProvider);
    expect(() => getEmbeddingAdapter('nonexistent-adapter-xyz')).toThrow(/nonexistent-adapter-xyz/);
  });

  it('UnknownEmbeddingProvider includes available names in message', () => {
    try {
      getEmbeddingAdapter('no-such-provider');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownEmbeddingProvider);
      const e = err as UnknownEmbeddingProvider;
      expect(e.requestedName).toBe('no-such-provider');
      expect(e.availableNames).toContain('openai-text-embedding-3-small');
    }
  });

  it('registers a custom adapter and resolves it', () => {
    const stub = new StubEmbeddingAdapter('test-registry-stub');
    registerEmbeddingAdapter(stub);

    const resolved = getEmbeddingAdapter('test-registry-stub');
    expect(resolved).toBe(stub);
    expect(resolved.name).toBe('test-registry-stub');
  });

  it('hasEmbeddingAdapter returns true for registered adapter', () => {
    expect(hasEmbeddingAdapter('openai-text-embedding-3-small')).toBe(true);
  });

  it('hasEmbeddingAdapter returns false for unregistered adapter', () => {
    expect(hasEmbeddingAdapter('totally-unregistered-xyz')).toBe(false);
  });

  it('listEmbeddingAdapters includes built-in adapter', () => {
    const names = listEmbeddingAdapters();
    expect(names).toContain('openai-text-embedding-3-small');
  });

  it('registry round-trip: register → resolve → verify identity', () => {
    const stub = new StubEmbeddingAdapter('registry-round-trip-test', 256);
    registerEmbeddingAdapter(stub);

    const resolved = getEmbeddingAdapter('registry-round-trip-test');
    expect(resolved.name).toBe('registry-round-trip-test');
    expect(resolved.dimensions).toBe(256);
    expect(resolved.capabilities.billingModel).toBe('pay-per-token');
  });
});

// ── OpenAI adapter: identity & capability matrix ─────────────────────────────

describe('OpenAITextEmbedding3Small — identity', () => {
  it('has correct name', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.name).toBe('openai-text-embedding-3-small');
  });

  it('has correct modelId', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.modelId).toBe('text-embedding-3-small');
  });

  it('has correct modelVersion snapshot date', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.modelVersion).toBe('2024-01-25');
  });

  it('has correct dimensions', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.dimensions).toBe(1536);
  });

  it('declares pay-per-token billing model (OQ-7 re-walkthrough)', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.capabilities.billingModel).toBe('pay-per-token');
  });

  it('capability matrix dimensions match top-level dimensions', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.capabilities.dimensions).toBe(adapter.dimensions);
  });

  it('declares supportsBatching = true', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.capabilities.supportsBatching).toBe(true);
  });

  it('declares selfHosted = false', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.capabilities.selfHosted).toBe(false);
  });

  it('declares OPENAI_API_KEY as required env var', () => {
    const adapter = new OpenAITextEmbedding3Small();
    expect(adapter.requires.envVar).toBe('OPENAI_API_KEY');
  });
});

// ── OpenAI adapter: isAvailable() probe ──────────────────────────────────────

describe('OpenAITextEmbedding3Small — isAvailable()', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnv;
    }
  });

  it('returns available=false when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const adapter = new OpenAITextEmbedding3Small();
    const result = await adapter.isAvailable();
    expect(result.available).toBe(false);
    expect(result.reason).toBe('env-var-missing');
    expect(result.detail).toMatch(/OPENAI_API_KEY/);
  });

  it('returns available=true when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-for-unit-test';
    const adapter = new OpenAITextEmbedding3Small();
    const result = await adapter.isAvailable();
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ── OpenAI adapter: getAccountId() ───────────────────────────────────────────

describe('OpenAITextEmbedding3Small — getAccountId()', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnv;
    }
  });

  it('returns null when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const adapter = new OpenAITextEmbedding3Small();
    const id = await adapter.getAccountId();
    expect(id).toBeNull();
  });

  it('returns a 64-char hex string when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-deterministic-key';
    const adapter = new OpenAITextEmbedding3Small();
    const id = await adapter.getAccountId();
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same key produces same id', async () => {
    process.env.OPENAI_API_KEY = 'sk-same-key-twice';
    const adapter = new OpenAITextEmbedding3Small();
    const id1 = await adapter.getAccountId();
    const id2 = await adapter.getAccountId();
    expect(id1).toBe(id2);
  });

  it('is different for different keys (MUST NOT leak credential)', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    process.env.OPENAI_API_KEY = 'sk-key-alpha';
    const id1 = await adapter.getAccountId();
    process.env.OPENAI_API_KEY = 'sk-key-beta';
    const id2 = await adapter.getAccountId();
    expect(id1).not.toBe(id2);
  });
});

// ── OpenAI adapter: embed() — error paths (no real API calls) ────────────────

describe('OpenAITextEmbedding3Small — embed() validation', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('throws on empty string input', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    await expect(adapter.embed('')).rejects.toThrow(/empty input rejected/);
  });

  it('throws on whitespace-only input', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    await expect(adapter.embed('   ')).rejects.toThrow(/empty input rejected/);
  });

  it('throws EmbeddingProviderError on API failure', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limit exceeded',
      }),
    );
    await expect(adapter.embed('hello world')).rejects.toThrow(/HTTP 429/);
  });

  it('throws EmbeddingDimensionMismatch when API returns wrong vector length', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(512).fill(0.1), index: 0 }], // wrong size: 512 vs 1536
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      }),
    );
    await expect(adapter.embed('hello world')).rejects.toThrow(EmbeddingDimensionMismatch);
  });

  it('returns a vector of length 1536 on success', async () => {
    const adapter = new OpenAITextEmbedding3Small();
    const fakeVector = new Array(1536).fill(0.1) as number[];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeVector, index: 0 }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
      }),
    );
    const result = await adapter.embed('test text');
    expect(result).toHaveLength(1536);
  });
});

// ── consumerLabel propagation through to cost-tracker (AC#7, OQ-6) ────────────

describe('consumerLabel propagation (OQ-6 re-walkthrough)', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-key-for-consumer-label';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('defaults consumerLabel to "unspecified" when not provided', async () => {
    const capturedRecords: EmbeddingCostRecord[] = [];
    const adapter = new OpenAITextEmbedding3Small((record) => capturedRecords.push(record));

    const fakeVector = new Array(1536).fill(0.2) as number[];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeVector, index: 0 }],
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      }),
    );

    await adapter.embed('some text');
    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0].consumerLabel).toBe('unspecified');
  });

  it('propagates explicit consumerLabel to cost-tracker callback', async () => {
    const capturedRecords: EmbeddingCostRecord[] = [];
    const adapter = new OpenAITextEmbedding3Small((record) => capturedRecords.push(record));

    const fakeVector = new Array(1536).fill(0.3) as number[];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeVector, index: 0 }],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
      }),
    );

    await adapter.embed('drift detection text', 'rfc-0009-tessellation-drift');
    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0].consumerLabel).toBe('rfc-0009-tessellation-drift');
  });

  it('cost record includes provider, modelVersion, accountId, tokens, costUsd', async () => {
    const capturedRecords: EmbeddingCostRecord[] = [];
    const adapter = new OpenAITextEmbedding3Small((record) => capturedRecords.push(record));

    const fakeVector = new Array(1536).fill(0.4) as number[];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeVector, index: 0 }],
          usage: { prompt_tokens: 100, total_tokens: 100 },
        }),
      }),
    );

    await adapter.embed('test for cost attribution', 'rfc-0008-ppa-similarity');
    const record = capturedRecords[0];

    expect(record.provider).toBe('openai-text-embedding-3-small');
    expect(record.modelVersion).toBe('2024-01-25');
    expect(record.accountId).toMatch(/^[0-9a-f]{64}$/); // one-way hash
    expect(record.tokens).toBe(100);
    expect(record.costUsd).toBeCloseTo((100 * 0.02) / 1_000_000, 10);
    expect(record.billingModel).toBe('pay-per-token');
    expect(record.consumerLabel).toBe('rfc-0008-ppa-similarity');
  });

  it('no callback = no error even when embed() succeeds', async () => {
    // Adapter without a cost callback should not throw
    const adapter = new OpenAITextEmbedding3Small(); // no callback

    const fakeVector = new Array(1536).fill(0.5) as number[];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeVector, index: 0 }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      }),
    );

    await expect(adapter.embed('no-callback test')).resolves.toHaveLength(1536);
  });
});

// ── billingModel field is correctly read by framework (AC#8, OQ-7) ────────────

describe('billingModel field (OQ-7 re-walkthrough)', () => {
  it('OpenAI adapter declares pay-per-token billing model', () => {
    const adapter = getEmbeddingAdapter('openai-text-embedding-3-small');
    expect(adapter.capabilities.billingModel).toBe('pay-per-token');
  });

  it('pay-per-token adapters do NOT consume subscription-quota', () => {
    // This test verifies the framework reads billingModel correctly.
    // The actual SubscriptionLedger routing is Phase 4 scope; here we
    // verify the field value that Phase 4 will read.
    const adapter = getEmbeddingAdapter('openai-text-embedding-3-small');
    const consumesSubscription = adapter.capabilities.billingModel === 'subscription-quota';
    expect(consumesSubscription).toBe(false);
  });

  it('custom adapter with subscription-quota billing model is preserved', () => {
    class SubscriptionAdapter extends StubEmbeddingAdapter {
      readonly capabilities: EmbeddingCapabilities = {
        dimensions: 384,
        maxInputTokens: 512,
        supportsBatching: false,
        selfHosted: false,
        billingModel: 'subscription-quota',
      };
    }
    const adapter = new SubscriptionAdapter('test-subscription-quota-adapter');
    registerEmbeddingAdapter(adapter);

    const resolved = getEmbeddingAdapter('test-subscription-quota-adapter');
    expect(resolved.capabilities.billingModel).toBe('subscription-quota');
  });
});

// ── Error classes ─────────────────────────────────────────────────────────────

describe('error classes', () => {
  it('UnknownEmbeddingProvider has correct name and fields', () => {
    const err = new UnknownEmbeddingProvider('bad-provider', ['a', 'b']);
    expect(err.name).toBe('UnknownEmbeddingProvider');
    expect(err.requestedName).toBe('bad-provider');
    expect(err.availableNames).toEqual(['a', 'b']);
    expect(err.message).toMatch(/bad-provider/);
    expect(err.message).toMatch(/a, b/);
  });

  it('EmbeddingProviderUnavailable has correct name and fields', () => {
    const err = new EmbeddingProviderUnavailable(
      'my-adapter',
      'env-var-missing',
      'MY_API_KEY not set',
    );
    expect(err.name).toBe('EmbeddingProviderUnavailable');
    expect(err.adapterName).toBe('my-adapter');
    expect(err.reason).toBe('env-var-missing');
    expect(err.detail).toBe('MY_API_KEY not set');
    expect(err.message).toMatch(/my-adapter/);
  });

  it('EmbeddingDimensionMismatch has correct name and fields', () => {
    const err = new EmbeddingDimensionMismatch('test-adapter', 1536, 512);
    expect(err.name).toBe('EmbeddingDimensionMismatch');
    expect(err.adapterName).toBe('test-adapter');
    expect(err.expectedDimensions).toBe(1536);
    expect(err.actualDimensions).toBe(512);
    expect(err.message).toMatch(/1536/);
    expect(err.message).toMatch(/512/);
  });

  it('EmbeddingModelRemoved has correct name and fields', () => {
    const err = new EmbeddingModelRemoved('old-adapter', '2025-01-01', 'new-adapter');
    expect(err.name).toBe('EmbeddingModelRemoved');
    expect(err.adapterName).toBe('old-adapter');
    expect(err.removedAt).toBe('2025-01-01');
    expect(err.replacementAlias).toBe('new-adapter');
    expect(err.message).toMatch(/new-adapter/);
  });

  it('EmbeddingModelDeprecated has correct name and fields', () => {
    const err = new EmbeddingModelDeprecated('old-adapter', '2025-06-01', 'new-adapter');
    expect(err.name).toBe('EmbeddingModelDeprecated');
    expect(err.deprecatedAt).toBe('2025-06-01');
    expect(err.replacementAlias).toBe('new-adapter');
    expect(err.message).toMatch(/cli-embedding-bump/);
  });
});
