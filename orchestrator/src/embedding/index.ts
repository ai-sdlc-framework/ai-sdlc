/**
 * Embedding adapter framework per RFC-0019.
 * Phase 1: interface + registry + OpenAI default adapter + errors.
 * Phase 2: vector storage backend + JSONL default + backend factory + GC.
 * Phase 3: stale-vector policy, cross-provider compatibility, deprecation
 *          lifecycle (AISDLC-339). Migration tooling itself lives in
 *          `pipeline-cli/src/cli/embedding-bump.ts`.
 * Phase 4 (AISDLC-340): pipeline-load wiring + first-consumer (Eτ drift) spec stub.
 *
 * Phase 5 (soak) ships in AISDLC-341.
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
  EmbeddingStaleVectorPolicy,
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

// Phase 3: stale-vector policy + cross-provider compatibility + deprecation lifecycle.
export type {
  StaleVectorPolicy,
  StaleVectorPolicyInput,
  StaleVectorContext,
  StaleVectorDecisionSeverity,
} from './stale-vector.js';
export {
  FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY,
  resolveStaleVectorPolicy,
  severityForPolicy,
  isCurrentVector,
  StaleVectorEncountered,
} from './stale-vector.js';

export type { ProviderCompatibility, CrossProviderDecisionPayload } from './cross-provider.js';
export {
  checkProviderCompatibility,
  CrossProviderComparisonError,
  buildCrossProviderDecisionPayload,
} from './cross-provider.js';

export type {
  DeprecationLifecycleInput,
  DeprecationLifecycleResult,
  DeprecationDecisionEvent,
  DeprecationPhase,
} from './deprecation.js';
export {
  FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS,
  DEPRECATION_MILESTONE_DAYS,
  resolveGracePeriodDays,
  nextDueMilestone,
  buildDedupKey,
  evaluateDeprecationLifecycle,
} from './deprecation.js';

// Phase 4 (AISDLC-340): pipeline-load wiring per RFC-0019 §10.1.
export {
  loadEmbeddingFromPipelineSpec,
  isEmbeddingFrameworkEnabled,
  resolveEffectiveGracePeriodDays,
  EMBEDDING_DEFAULTS,
} from './pipeline-load.js';
export type {
  EmbeddingSpecInput,
  ResolvedEmbedding,
  LoadEmbeddingOptions,
  DeprecationWarningEvent,
} from './pipeline-load.js';

// Phase 4 (AISDLC-340): first downstream consumer spec stub
// (RFC-0009 Eτ_tessellation_drift — runtime usage activates when AISDLC-317 ships).
export {
  TESSELLATION_DRIFT_CONSUMER_LABEL,
  TESSELLATION_DRIFT_STALE_VECTOR_POLICY,
  TESSELLATION_DRIFT_CONSUMER,
  embedDriftSignal,
} from './consumers/tessellation-drift.js';
