/**
 * Tests for RFC-0019 Phase 4 pipeline-load wiring (AISDLC-340).
 *
 * Covers:
 *  AC#1 — Pipeline.spec.embedding schema is honored (defaults filled in)
 *  AC#2 — pipeline-load resolves provider name → registered adapter +
 *         instantiates the named storage backend
 *  AC#3 — staleVectorPolicy default flows through; consumer overrides
 *         at the API site (tested in tessellation-drift.test.ts)
 *  AC#6 — schema honors deprecationOverrides + storageBackend defaults
 *  Feature-flag behaviour (off vs on)
 *  Deprecation gate (warning + strict-fail + removed)
 *  Three-layer precedence for gracePeriodDays
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadEmbeddingFromPipelineSpec,
  isEmbeddingFrameworkEnabled,
  resolveEffectiveGracePeriodDays,
  EMBEDDING_DEFAULTS,
  type DeprecationWarningEvent,
  type EmbeddingSpecInput,
} from './pipeline-load.js';
import { registerEmbeddingAdapter, getEmbeddingAdapter } from './registry.js';
import type { EmbeddingAdapter, EmbeddingAvailability } from './types.js';
import {
  UnknownEmbeddingProvider,
  EmbeddingModelDeprecated,
  EmbeddingModelRemoved,
} from './errors.js';

// ── Stub adapters for hermetic tests ─────────────────────────────────────────

class StubAdapter implements EmbeddingAdapter {
  readonly name: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions = 8;
  readonly capabilities;
  readonly requires = { envVar: 'STUB_KEY' };
  readonly deprecatedAt?: string;
  readonly removedAt?: string;
  readonly replacementAlias?: string;

  constructor(opts: {
    name: string;
    deprecatedAt?: string;
    removedAt?: string;
    replacementAlias?: string;
    adapterDefaultGracePeriodDays?: number;
  }) {
    this.name = opts.name;
    this.modelId = opts.name;
    this.modelVersion = '2026-05-23';
    this.deprecatedAt = opts.deprecatedAt;
    this.removedAt = opts.removedAt;
    this.replacementAlias = opts.replacementAlias;
    const caps: Record<string, unknown> = {
      dimensions: 8,
      maxInputTokens: 8000,
      supportsBatching: false,
      selfHosted: false,
      billingModel: 'pay-per-token',
    };
    if (opts.adapterDefaultGracePeriodDays !== undefined) {
      caps.defaultGracePeriodDays = opts.adapterDefaultGracePeriodDays;
    }
    // EmbeddingCapabilities is the base; the adapter-declared
    // defaultGracePeriodDays is read via duck-typing.
    this.capabilities = caps as unknown as EmbeddingAdapter['capabilities'];
  }

  async embed(_text: string, _consumerLabel?: string): Promise<number[]> {
    return Array.from({ length: this.dimensions }, () => 0);
  }
  async isAvailable(): Promise<EmbeddingAvailability> {
    return { available: true };
  }
  async getAccountId(): Promise<string | null> {
    return 'stub-account';
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Force-clear flag so default state is OFF.
  delete process.env.AI_SDLC_EMBEDDING_PROVIDER;
});

afterEach(() => {
  // Restore env between tests.
  process.env = { ...ORIGINAL_ENV };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isEmbeddingFrameworkEnabled', () => {
  it('returns false when env var is unset', () => {
    expect(isEmbeddingFrameworkEnabled({})).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON'])(
    'returns true for truthy value %s',
    (value) => {
      expect(isEmbeddingFrameworkEnabled({ AI_SDLC_EMBEDDING_PROVIDER: value })).toBe(true);
    },
  );

  it.each(['', '0', 'false', 'no', 'off', 'maybe'])(
    'returns false for non-truthy value %s',
    (value) => {
      expect(isEmbeddingFrameworkEnabled({ AI_SDLC_EMBEDDING_PROVIDER: value })).toBe(false);
    },
  );
});

describe('loadEmbeddingFromPipelineSpec — feature flag', () => {
  it('returns null when spec is null/undefined regardless of flag', () => {
    process.env.AI_SDLC_EMBEDDING_PROVIDER = 'on';
    expect(loadEmbeddingFromPipelineSpec(null)).toBeNull();
    expect(loadEmbeddingFromPipelineSpec(undefined)).toBeNull();
  });

  it('returns null when flag is off (even when spec is present)', () => {
    const stub = new StubAdapter({ name: 'stub-flag-off-provider' });
    registerEmbeddingAdapter(stub);

    const onFlagOffWithSpec = vi.fn();
    const result = loadEmbeddingFromPipelineSpec({ provider: stub.name }, { onFlagOffWithSpec });

    expect(result).toBeNull();
    expect(onFlagOffWithSpec).toHaveBeenCalledTimes(1);
  });
});

describe('loadEmbeddingFromPipelineSpec — happy path', () => {
  let artifactsDir: string;

  beforeEach(() => {
    process.env.AI_SDLC_EMBEDDING_PROVIDER = 'on';
    artifactsDir = mkdtempSync(join(tmpdir(), 'embed-load-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('resolves adapter + storage with defaults filled in', () => {
    const stub = new StubAdapter({ name: 'stub-happy-path-provider' });
    registerEmbeddingAdapter(stub);

    const result = loadEmbeddingFromPipelineSpec({ provider: stub.name }, { artifactsDir });

    expect(result).not.toBeNull();
    expect(result!.adapter).toBe(stub);
    expect(result!.storage.name).toBe('jsonl');
    expect(result!.staleVectorPolicy).toBe(EMBEDDING_DEFAULTS.staleVectorPolicy);
    expect(result!.autoEmbedOnWrite).toBe(EMBEDDING_DEFAULTS.autoEmbedOnWrite);
    expect(result!.maxBatchSize).toBe(EMBEDDING_DEFAULTS.maxBatchSize);
    expect(result!.fallbackAdapter).toBeUndefined();
  });

  it('honors per-spec overrides for staleVectorPolicy / batch / autoEmbed', () => {
    const stub = new StubAdapter({ name: 'stub-overrides-provider' });
    registerEmbeddingAdapter(stub);

    const result = loadEmbeddingFromPipelineSpec(
      {
        provider: stub.name,
        staleVectorPolicy: 'fail-loud',
        autoEmbedOnWrite: false,
        maxBatchSize: 32,
      },
      { artifactsDir },
    );

    expect(result!.staleVectorPolicy).toBe('fail-loud');
    expect(result!.autoEmbedOnWrite).toBe(false);
    expect(result!.maxBatchSize).toBe(32);
  });

  it('resolves a fallback adapter when distinct from the primary', () => {
    const primary = new StubAdapter({ name: 'stub-primary' });
    const fallback = new StubAdapter({ name: 'stub-fallback' });
    registerEmbeddingAdapter(primary);
    registerEmbeddingAdapter(fallback);

    const result = loadEmbeddingFromPipelineSpec(
      { provider: primary.name, fallback: fallback.name },
      { artifactsDir },
    );

    expect(result!.adapter).toBe(primary);
    expect(result!.fallbackAdapter).toBe(fallback);
  });

  it('omits fallbackAdapter when fallback === provider', () => {
    const stub = new StubAdapter({ name: 'stub-fallback-same' });
    registerEmbeddingAdapter(stub);

    const result = loadEmbeddingFromPipelineSpec(
      { provider: stub.name, fallback: stub.name },
      { artifactsDir },
    );

    expect(result!.fallbackAdapter).toBeUndefined();
  });

  it('throws UnknownEmbeddingProvider when adapter name is not registered', () => {
    expect(() =>
      loadEmbeddingFromPipelineSpec({ provider: 'definitely-not-real' }, { artifactsDir }),
    ).toThrow(UnknownEmbeddingProvider);
  });

  it('throws on unknown storageBackend', () => {
    const stub = new StubAdapter({ name: 'stub-storage' });
    registerEmbeddingAdapter(stub);

    expect(() =>
      loadEmbeddingFromPipelineSpec(
        { provider: stub.name, storageBackend: 'pgvector' },
        { artifactsDir },
      ),
    ).toThrow(/Unknown embedding storage backend 'pgvector'/);
  });
});

describe('loadEmbeddingFromPipelineSpec — deprecation gate', () => {
  let artifactsDir: string;

  beforeEach(() => {
    process.env.AI_SDLC_EMBEDDING_PROVIDER = 'on';
    artifactsDir = mkdtempSync(join(tmpdir(), 'embed-dep-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('throws EmbeddingModelRemoved when now >= removedAt', () => {
    const stub = new StubAdapter({
      name: 'stub-removed',
      removedAt: '2026-01-01',
      replacementAlias: 'newer',
    });
    registerEmbeddingAdapter(stub);

    expect(() =>
      loadEmbeddingFromPipelineSpec(
        { provider: stub.name },
        { artifactsDir, now: new Date('2026-06-01T00:00:00Z') },
      ),
    ).toThrow(EmbeddingModelRemoved);
  });

  it('throws EmbeddingModelDeprecated past deprecatedAt in strict mode', () => {
    const stub = new StubAdapter({
      name: 'stub-deprecated-strict',
      deprecatedAt: '2026-01-01',
      replacementAlias: 'newer',
    });
    registerEmbeddingAdapter(stub);

    expect(() =>
      loadEmbeddingFromPipelineSpec(
        {
          provider: stub.name,
          deprecationOverrides: { strictModeAtDeprecatedAt: true },
        },
        { artifactsDir, now: new Date('2026-06-01T00:00:00Z') },
      ),
    ).toThrow(EmbeddingModelDeprecated);
  });

  it('emits warning event (continues load) past deprecatedAt in default mode', () => {
    const stub = new StubAdapter({
      name: 'stub-deprecated-default',
      deprecatedAt: '2026-01-01',
    });
    registerEmbeddingAdapter(stub);
    const onDeprecationWarning = vi.fn();

    const result = loadEmbeddingFromPipelineSpec(
      { provider: stub.name },
      { artifactsDir, now: new Date('2026-06-01T00:00:00Z'), onDeprecationWarning },
    );

    expect(result).not.toBeNull();
    expect(onDeprecationWarning).toHaveBeenCalledTimes(1);
    const event = onDeprecationWarning.mock.calls[0][0] as DeprecationWarningEvent;
    expect(event.adapterName).toBe(stub.name);
    expect(event.deprecatedAt).toBe('2026-01-01');
    expect(event.daysUntilDeprecated).toBeLessThanOrEqual(0);
  });

  it('emits warning inside the grace window (before deprecatedAt)', () => {
    const stub = new StubAdapter({
      name: 'stub-deprecated-warn-window',
      deprecatedAt: '2026-06-30',
    });
    registerEmbeddingAdapter(stub);
    const onDeprecationWarning = vi.fn();

    // 30 days before deprecatedAt → well inside framework default 90d.
    const result = loadEmbeddingFromPipelineSpec(
      { provider: stub.name },
      { artifactsDir, now: new Date('2026-05-31T00:00:00Z'), onDeprecationWarning },
    );

    expect(result).not.toBeNull();
    expect(onDeprecationWarning).toHaveBeenCalledTimes(1);
    const event = onDeprecationWarning.mock.calls[0][0] as DeprecationWarningEvent;
    expect(event.daysUntilDeprecated).toBeGreaterThan(0);
    expect(event.daysUntilDeprecated).toBeLessThanOrEqual(30);
    expect(event.effectiveGracePeriodDays).toBe(EMBEDDING_DEFAULTS.gracePeriodDays);
  });

  it('does NOT warn when today is BEFORE the warning window', () => {
    const stub = new StubAdapter({
      name: 'stub-deprecated-not-yet',
      deprecatedAt: '2027-01-01',
    });
    registerEmbeddingAdapter(stub);
    const onDeprecationWarning = vi.fn();

    loadEmbeddingFromPipelineSpec(
      { provider: stub.name },
      { artifactsDir, now: new Date('2026-05-23T00:00:00Z'), onDeprecationWarning },
    );

    expect(onDeprecationWarning).not.toHaveBeenCalled();
  });
});

describe('resolveEffectiveGracePeriodDays — three-layer precedence', () => {
  it('uses framework default when adapter + per-org both omit', () => {
    const stub = new StubAdapter({ name: 'stub-grace-framework' });
    expect(resolveEffectiveGracePeriodDays(stub, { provider: stub.name })).toBe(
      EMBEDDING_DEFAULTS.gracePeriodDays,
    );
  });

  it('uses adapter-declared default when per-org omits', () => {
    const stub = new StubAdapter({
      name: 'stub-grace-adapter',
      adapterDefaultGracePeriodDays: 30,
    });
    expect(resolveEffectiveGracePeriodDays(stub, { provider: stub.name })).toBe(30);
  });

  it('uses per-org override when present (wins over adapter + framework)', () => {
    const stub = new StubAdapter({
      name: 'stub-grace-per-org',
      adapterDefaultGracePeriodDays: 30,
    });
    expect(
      resolveEffectiveGracePeriodDays(stub, {
        provider: stub.name,
        deprecationOverrides: { gracePeriodDays: 14 },
      }),
    ).toBe(14);
  });

  it('ignores zero/negative per-org override (falls back to next layer)', () => {
    const stub = new StubAdapter({
      name: 'stub-grace-invalid-per-org',
      adapterDefaultGracePeriodDays: 30,
    });
    expect(
      resolveEffectiveGracePeriodDays(stub, {
        provider: stub.name,
        deprecationOverrides: { gracePeriodDays: 0 },
      }),
    ).toBe(30);
  });
});

describe('loadEmbeddingFromPipelineSpec — interaction with registry', () => {
  it('built-in OpenAI adapter is resolvable via spec', () => {
    process.env.AI_SDLC_EMBEDDING_PROVIDER = 'on';
    const artifactsDir = mkdtempSync(join(tmpdir(), 'embed-builtin-'));
    try {
      const builtIn = getEmbeddingAdapter('openai-text-embedding-3-small');
      const result = loadEmbeddingFromPipelineSpec(
        { provider: 'openai-text-embedding-3-small' } satisfies EmbeddingSpecInput,
        { artifactsDir },
      );
      expect(result?.adapter).toBe(builtIn);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
