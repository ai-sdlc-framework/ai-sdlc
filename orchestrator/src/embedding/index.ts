/**
 * Embedding adapter framework per RFC-0019.
 * Phase 1: interface + registry + OpenAI default adapter + errors.
 * Phase 2: vector storage backend + JSONL default + backend factory + GC.
 *
 * Phases 3-5 (migration tooling, pipeline integration, soak) ship in
 * AISDLC-339 through AISDLC-341.
 */

export type {
  EmbeddingAdapter,
  EmbeddingAvailability,
  EmbeddingCapabilities,
  EmbeddingRequires,
  EmbeddingBillingModel,
  EmbeddingCostRecord,
} from './types.js';

export {
  EmbeddingError,
  UnknownEmbeddingProvider,
  EmbeddingProviderUnavailable,
  EmbeddingProviderError,
  EmbeddingDimensionMismatch,
  EmbeddingModelDeprecating,
  EmbeddingModelDeprecated,
  EmbeddingModelRemoved,
} from './errors.js';

export {
  getEmbeddingAdapter,
  registerEmbeddingAdapter,
  hasEmbeddingAdapter,
  listEmbeddingAdapters,
} from './registry.js';

export { OpenAITextEmbedding3Small } from './adapters/openai-text-embedding-3-small.js';
export type { EmbeddingCostCallback } from './adapters/openai-text-embedding-3-small.js';

// Phase 2: vector storage backend + JSONL default + backend factory.
export type {
  EmbeddingStorageBackend,
  VectorStoreEntry,
  VectorStoreFilter,
} from './storage/types.js';
export {
  JsonlEmbeddingStorageBackend,
  SCALE_ESCALATION_MAX_ENTRIES,
  SCALE_ESCALATION_P95_READ_MS,
  createEmbeddingStorageBackend,
} from './storage/index.js';
export type {
  ScaleEscalationSignal,
  StorageBackendName,
  StorageBackendOptions,
} from './storage/index.js';
