/**
 * Pipeline-load wiring for RFC-0019 §10.1 / Phase 4 (AISDLC-340).
 *
 * Resolves `Pipeline.spec.embedding` → adapter (via registry) + storage
 * backend (via factory). This is the single entry point pipeline loaders
 * call when constructing the embedding substrate for a pipeline run.
 *
 * Feature-flag semantics:
 *   AI_SDLC_EMBEDDING_PROVIDER=on    → load per spec
 *   anything else / unset            → return null (framework disabled)
 *
 * When the flag is off AND a spec is present, callers SHOULD log a
 * warning so misconfiguration is visible — done here via the optional
 * `onFlagOffWithSpec` callback so the orchestrator can route the
 * warning through its own logging surface (events.jsonl, console, etc.).
 *
 * Errors:
 *   - Unknown adapter name → `UnknownEmbeddingProvider`
 *   - Unknown storage backend → bare `Error` from the storage factory
 *   - Adapter is deprecated/removed → re-thrown from the deprecation
 *     gate; pipeline-load aborts so operators see the failure at load
 *     time, not at first embed().
 *
 * Tests: `pipeline-load.test.ts`
 */

import { getEmbeddingAdapter } from './registry.js';
import { createEmbeddingStorageBackend } from './storage/index.js';
import type { EmbeddingStorageBackend } from './storage/types.js';
import type { EmbeddingAdapter } from './types.js';
import {
  EmbeddingModelDeprecated,
  EmbeddingModelDeprecating,
  EmbeddingModelRemoved,
} from './errors.js';

/**
 * Minimal subset of `Pipeline.spec.embedding` that pipeline-load reads.
 * Defined here (rather than imported from `@ai-sdlc/reference`) to avoid
 * a circular dependency — orchestrator already depends on reference,
 * and reference must not depend on orchestrator.
 */
export interface EmbeddingSpecInput {
  provider: string;
  fallback?: string;
  storageBackend?: string;
  storageBackendConfig?: Record<string, unknown>;
  staleVectorPolicy?: 'lazy-re-embed' | 'fail-loud' | 'warn';
  autoEmbedOnWrite?: boolean;
  maxBatchSize?: number;
  deprecationOverrides?: {
    gracePeriodDays?: number;
    strictModeAtDeprecatedAt?: boolean;
  };
}

/**
 * Resolved embedding substrate returned by `loadEmbeddingFromPipelineSpec()`.
 *
 * Callers wire `adapter` into their embed() call sites and `storage` into
 * their write/read paths. `staleVectorPolicy` is the per-org default;
 * consumers MAY override at the API site per OQ-2 re-walkthrough.
 */
export interface ResolvedEmbedding {
  adapter: EmbeddingAdapter;
  /** Resolved fallback adapter (when distinct from primary). */
  fallbackAdapter?: EmbeddingAdapter;
  storage: EmbeddingStorageBackend;
  /** Per-org default; consumers may pin a stricter policy at the API site. */
  staleVectorPolicy: 'lazy-re-embed' | 'fail-loud' | 'warn';
  autoEmbedOnWrite: boolean;
  maxBatchSize: number;
}

/** Default values applied when fields are omitted from the spec. */
export const EMBEDDING_DEFAULTS = {
  storageBackend: 'jsonl' as const,
  staleVectorPolicy: 'lazy-re-embed' as const,
  autoEmbedOnWrite: true,
  maxBatchSize: 2048,
  /** Framework default; adapter MAY declare a different defaultGracePeriodDays. */
  gracePeriodDays: 90,
} as const;

/** Options for the loader. */
export interface LoadEmbeddingOptions {
  /**
   * Path to the artifacts directory. Used by the storage backend factory.
   * Defaults to `process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts'`.
   */
  artifactsDir?: string;
  /**
   * Today, for deprecation-window math. Defaults to `new Date()`.
   * Tests inject a fixed date so deprecation-gate behaviour is hermetic.
   */
  now?: Date;
  /**
   * Called when `AI_SDLC_EMBEDDING_PROVIDER` is OFF but a non-null spec
   * was passed. Lets the orchestrator route the warning to events.jsonl
   * or another logging surface without coupling the loader to a logger.
   */
  onFlagOffWithSpec?: (spec: EmbeddingSpecInput) => void;
  /**
   * Called when a deprecation WARNING fires (between adapter's effective
   * `(deprecatedAt − gracePeriodDays)` and `deprecatedAt`). Operators
   * SHOULD route this to the Decision catalog with milestone dedup.
   */
  onDeprecationWarning?: (event: DeprecationWarningEvent) => void;
}

/** Event surfaced by the deprecation gate during the warning window. */
export interface DeprecationWarningEvent {
  adapterName: string;
  deprecatedAt: string;
  removedAt?: string;
  replacementAlias?: string;
  daysUntilDeprecated: number;
  /** Effective gracePeriodDays after applying three-layer precedence. */
  effectiveGracePeriodDays: number;
}

/**
 * `AI_SDLC_EMBEDDING_PROVIDER` flag parser. Mirrors the
 * `AI_SDLC_DEPS_COMPOSITION` and `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` patterns:
 * truthy = `1|true|yes|on` (case-insensitive); anything else (including
 * unset) is OFF.
 */
export function isEmbeddingFrameworkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AI_SDLC_EMBEDDING_PROVIDER;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * Resolve `(adapter, storage, policy)` from a pipeline spec.
 *
 * Returns `null` when the framework is disabled — by feature flag OR by
 * absent spec. Callers SHOULD treat null as "no embedding substrate
 * available" and let consumers emit `EmbeddingProviderNotConfigured`.
 *
 * Throws on:
 *   - unknown adapter (`UnknownEmbeddingProvider`)
 *   - unknown storage backend (bare `Error`)
 *   - adapter past `removedAt` (`EmbeddingModelRemoved`)
 *   - adapter past `deprecatedAt` in strict mode (`EmbeddingModelDeprecated`)
 *
 * @example
 *   const substrate = loadEmbeddingFromPipelineSpec(
 *     pipeline.spec.embedding,
 *     { artifactsDir: '/repo/.ai-sdlc/artifacts' },
 *   );
 *   if (substrate) {
 *     const vec = await substrate.adapter.embed('hello', 'rfc-0009-tessellation-drift');
 *     await substrate.storage.write({ ... });
 *   }
 */
export function loadEmbeddingFromPipelineSpec(
  spec: EmbeddingSpecInput | null | undefined,
  options: LoadEmbeddingOptions = {},
): ResolvedEmbedding | null {
  if (!spec) {
    return null;
  }

  if (!isEmbeddingFrameworkEnabled()) {
    options.onFlagOffWithSpec?.(spec);
    return null;
  }

  const adapter = getEmbeddingAdapter(spec.provider);

  // Deprecation gate. Strict mode FAILs at deprecatedAt; default mode
  // continues to warn until removedAt (RFC-0019 OQ-4 re-walkthrough).
  const now = options.now ?? new Date();
  enforceDeprecationGate(adapter, spec, now, options.onDeprecationWarning);

  // Resolve fallback (when distinct). Fallback failures don't block
  // load — they surface at runtime when the primary is unavailable.
  let fallbackAdapter: EmbeddingAdapter | undefined;
  if (spec.fallback && spec.fallback !== spec.provider) {
    fallbackAdapter = getEmbeddingAdapter(spec.fallback);
  }

  const artifactsDir = options.artifactsDir ?? process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts';
  const storage = createEmbeddingStorageBackend(
    spec.storageBackend ?? EMBEDDING_DEFAULTS.storageBackend,
    artifactsDir,
  );

  return {
    adapter,
    fallbackAdapter,
    storage,
    staleVectorPolicy: spec.staleVectorPolicy ?? EMBEDDING_DEFAULTS.staleVectorPolicy,
    autoEmbedOnWrite: spec.autoEmbedOnWrite ?? EMBEDDING_DEFAULTS.autoEmbedOnWrite,
    maxBatchSize: spec.maxBatchSize ?? EMBEDDING_DEFAULTS.maxBatchSize,
  };
}

/**
 * Three-layer precedence per OQ-4 re-walkthrough:
 *   framework default (90d) → adapter.defaultGracePeriodDays → per-org override
 *
 * Returned value is the effective grace period in days for THIS load.
 */
export function resolveEffectiveGracePeriodDays(
  adapter: EmbeddingAdapter,
  spec: EmbeddingSpecInput,
): number {
  const perOrg = spec.deprecationOverrides?.gracePeriodDays;
  if (typeof perOrg === 'number' && perOrg > 0) return perOrg;
  // Adapter-declared default lives on `capabilities` per OQ-4; we read it
  // through a duck-typed lookup so adapters that don't declare it still
  // type-check. (`EmbeddingCapabilities` is intentionally not extended
  // here — the field is OPTIONAL and only known adapters set it.)
  const adapterDeclared = (adapter.capabilities as { defaultGracePeriodDays?: number })
    .defaultGracePeriodDays;
  if (typeof adapterDeclared === 'number' && adapterDeclared > 0) return adapterDeclared;
  return EMBEDDING_DEFAULTS.gracePeriodDays;
}

/**
 * Deprecation gate. Behaviour per OQ-4 re-walkthrough:
 *   - past removedAt              → throw EmbeddingModelRemoved
 *   - past deprecatedAt + strict  → throw EmbeddingModelDeprecated
 *   - past deprecatedAt + default → emit warning event (continue load)
 *   - inside grace window         → emit warning event (continue load)
 *
 * Catalog dedup (milestone counter at 89/60/30/7/1d before deprecatedAt) is
 * the CALLER's responsibility — the loader emits one warning event per load;
 * the orchestrator's Decision-catalog writer deduplicates by Decision key.
 */
function enforceDeprecationGate(
  adapter: EmbeddingAdapter,
  spec: EmbeddingSpecInput,
  now: Date,
  onDeprecationWarning?: (event: DeprecationWarningEvent) => void,
): void {
  if (adapter.removedAt) {
    const removedAt = new Date(adapter.removedAt);
    if (now >= removedAt) {
      throw new EmbeddingModelRemoved(adapter.name, adapter.removedAt, adapter.replacementAlias);
    }
  }

  if (!adapter.deprecatedAt) return;

  const deprecatedAt = new Date(adapter.deprecatedAt);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilDeprecated = Math.ceil((deprecatedAt.getTime() - now.getTime()) / msPerDay);

  if (now >= deprecatedAt) {
    if (spec.deprecationOverrides?.strictModeAtDeprecatedAt) {
      throw new EmbeddingModelDeprecated(
        adapter.name,
        adapter.deprecatedAt,
        adapter.replacementAlias,
      );
    }
    // Default mode: continue + emit warning (operators see the signal,
    // pipeline keeps running until removedAt — per OQ-4 re-walkthrough).
    onDeprecationWarning?.({
      adapterName: adapter.name,
      deprecatedAt: adapter.deprecatedAt,
      removedAt: adapter.removedAt,
      replacementAlias: adapter.replacementAlias,
      daysUntilDeprecated,
      effectiveGracePeriodDays: resolveEffectiveGracePeriodDays(adapter, spec),
    });
    // Surface the deprecating type as a side-effect-free reminder. We
    // throw nothing here — load proceeds — but instantiate the error
    // class so its shape stays in scope for diagnostic logging consumers.
    void new EmbeddingModelDeprecating(
      adapter.name,
      adapter.deprecatedAt,
      adapter.replacementAlias,
    );
    return;
  }

  const effectiveGrace = resolveEffectiveGracePeriodDays(adapter, spec);
  if (daysUntilDeprecated <= effectiveGrace) {
    onDeprecationWarning?.({
      adapterName: adapter.name,
      deprecatedAt: adapter.deprecatedAt,
      removedAt: adapter.removedAt,
      replacementAlias: adapter.replacementAlias,
      daysUntilDeprecated,
      effectiveGracePeriodDays: effectiveGrace,
    });
  }
}
