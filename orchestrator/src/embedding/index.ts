/**
 * Embedding adapter framework per RFC-0019.
 * Phase 1 surface: interface + registry + OpenAI default adapter + errors.
 *
 * Phases 2-5 (storage, migration, pipeline integration, soak) ship in
 * AISDLC-338 through AISDLC-341 and are explicitly out of scope here.
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
