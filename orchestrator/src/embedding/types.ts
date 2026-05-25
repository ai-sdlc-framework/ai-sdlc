/**
 * EmbeddingAdapter interface per RFC-0019 §5.
 *
 * Every embedding adapter MUST implement this interface. Adapters are registered
 * in orchestrator/src/embedding/registry.ts and resolved by name at pipeline-load.
 *
 * The pattern mirrors HarnessAdapter (RFC-0010 §13) and DatabaseBranchAdapter (RFC-0010 §15).
 */

/**
 * Result of an adapter liveness probe (isAvailable()).
 */
export interface EmbeddingAvailability {
  available: boolean;
  /** Structured reason — helps operators understand what to fix. */
  reason?: 'env-var-missing' | 'health-check-failed' | 'rate-limited' | 'unknown';
  /** Human-readable detail naming the missing env var or failing probe. */
  detail?: string;
}

/**
 * Runtime dependency declaration for an embedding adapter.
 * Parallel to HarnessRequires in RFC-0010 §13.8.
 */
export interface EmbeddingRequires {
  /** Environment variable required by this adapter (e.g., 'OPENAI_API_KEY'). */
  envVar?: string;
  /** Optional npm package or binary name required (for local/ONNX adapters). */
  binary?: string;
  /** Semver range for the binary, if applicable. */
  versionRange?: string;
  /** Path to model file (e.g., for ONNX-based adapters). */
  modelFile?: string;
}

/**
 * Billing model for the adapter — drives cost-tracker routing.
 *
 * - 'pay-per-token': tokens are billed via provider invoice (e.g., OpenAI).
 *   embeddingTokens are recorded in cost-tracker but do NOT consume SubscriptionLedger
 *   window quota (OQ-7 re-walkthrough).
 * - 'subscription-quota': tokens are billed via the operator's subscription
 *   (e.g., future Anthropic embeddings). Routes through SubscriptionLedger via
 *   the inputTokens/outputTokens mechanism.
 */
export type EmbeddingBillingModel = 'pay-per-token' | 'subscription-quota';

/**
 * Capability matrix for an embedding adapter (RFC-0019 §6.2).
 * Normative for in-tree adapters; adopter-registered adapters SHOULD declare these.
 */
export interface EmbeddingCapabilities {
  /** Output vector length. */
  dimensions: number;
  /** Maximum tokens per single embed() call. */
  maxInputTokens: number;
  /** Whether the adapter implements embedBatch(). */
  supportsBatching: boolean;
  /** Whether the adapter runs locally (no external API call). */
  selfHosted: boolean;
  /** Billing model — drives cost-tracker routing (OQ-7 re-walkthrough). */
  billingModel: EmbeddingBillingModel;
  /** Approximate cost per 1M tokens in USD (for display / cost estimation). Null for local. */
  approxCostPer1MTokens?: number;
  /**
   * Adapter-declared default deprecation grace period in days per RFC-0019
   * §9.1 OQ-4 re-walkthrough. When set, this overrides the framework default
   * (90d) but is itself overridden by per-org `gracePeriodDays`. Fast-moving
   * providers (e.g., Cohere with 6-month deprecation cycles) declare a smaller
   * value here so the warning window scales to the provider's actual lifecycle.
   *
   * The three-layer precedence is:
   *   per-org `gracePeriodDays` (highest)
   *   adapter `defaultGracePeriodDays` (this field)
   *   framework `FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS` (90, lowest)
   */
  defaultGracePeriodDays?: number;
}

/**
 * The EmbeddingAdapter interface per RFC-0019 §5.
 * Implemented by every embedding adapter registered in the registry.
 */
export interface EmbeddingAdapter {
  // ── Identity ────────────────────────────────────────────────────────────────

  /**
   * Canonical adapter alias — the value adopters set in Pipeline.spec.embedding.provider.
   * MUST be unique across the registry. Convention: '<vendor>-<model-family>-<size>'.
   * Examples: 'openai-text-embedding-3-small', 'cohere-embed-v3-multilingual'.
   */
  readonly name: string;

  /**
   * Provider-specific model identifier — passed to the upstream API.
   * Example: 'text-embedding-3-small' (posted to OpenAI's /embeddings endpoint).
   */
  readonly modelId: string;

  /**
   * Snapshot identifier — ISO date for date-pinned snapshots, semver for versioned models.
   * Used as part of the storage key so vectors don't collide across model snapshots.
   * Example: '2024-01-25' for OpenAI's 2024-01-25 text-embedding-3-small snapshot.
   */
  readonly modelVersion: string;

  /**
   * Vector length the adapter emits. Validated against storage on first write.
   * Redundant with capabilities.dimensions but declared at the top level for
   * fast dimension-mismatch detection without unpacking capabilities.
   */
  readonly dimensions: number;

  /** Static capability matrix. */
  readonly capabilities: EmbeddingCapabilities;

  /** Runtime dependency declaration. */
  readonly requires: EmbeddingRequires;

  // ── Deprecation lifecycle (mirrors RFC-0010 §11 model alias pattern) ────────

  /**
   * ISO date when the deprecation warning period starts.
   * When set, pipeline-load emits EmbeddingModelDeprecating warning 90d before
   * and EmbeddingModelDeprecated error at/after this date.
   */
  readonly deprecatedAt?: string;

  /**
   * ISO date when the adapter is removed.
   * When set AND today >= removedAt, pipeline-load FAILS with EmbeddingModelRemoved.
   */
  readonly removedAt?: string;

  /**
   * Canonical name of the adapter operators should migrate to.
   * Included in deprecation warnings/errors.
   */
  readonly replacementAlias?: string;

  // ── Core API ─────────────────────────────────────────────────────────────────

  /**
   * Embed a single text string. Returns the vector as number[].
   *
   * Implementations MUST:
   *  - throw on empty input (no silent zero-vector emission)
   *  - throw on input exceeding the provider's per-call token limit
   *  - return a vector of length === this.dimensions (orchestrator validates post-hoc)
   *
   * @param text - Source text to embed. MUST be non-empty.
   * @param consumerLabel - Optional label for cost attribution per OQ-6 re-walkthrough.
   *   Default: 'unspecified'. Examples: 'rfc-0009-tessellation-drift', 'rfc-0008-ppa-similarity'.
   */
  embed(text: string, consumerLabel?: string): Promise<number[]>;

  /**
   * Optional batch interface. Adapters MAY implement for efficiency; orchestrator
   * calls embed() in a loop when this is undefined.
   * Implementations MUST preserve input order in the returned array.
   *
   * @param texts - Array of source texts to embed. Each MUST be non-empty.
   * @param consumerLabel - Optional label for cost attribution. Applies to all texts in batch.
   */
  embedBatch?(texts: string[], consumerLabel?: string): Promise<number[][]>;

  /**
   * Cheap liveness probe. Combines env-var presence (e.g., OPENAI_API_KEY)
   * + lightweight provider health check (optional).
   * Result MAY be cached for the orchestrator's lifetime.
   */
  isAvailable(): Promise<EmbeddingAvailability>;

  /**
   * Stable identifier for the credential / account in scope. Used by cost-tracker
   * to attribute spend per credential. MUST be a one-way derivation (e.g., SHA-256
   * of the API key + adapter name) and MUST NOT leak the credential itself.
   * Returns null when the adapter cannot derive an account identity (e.g., self-hosted).
   */
  getAccountId(): Promise<string | null>;
}

/**
 * Record of a single embedding cost event, passed to the cost-tracker.
 * Captures the (provider, modelVersion, accountId, consumerLabel) dimensions
 * per OQ-6 re-walkthrough.
 */
export interface EmbeddingCostRecord {
  /** Adapter name (e.g., 'openai-text-embedding-3-small'). */
  provider: string;
  /** Adapter model version (e.g., '2024-01-25'). */
  modelVersion: string;
  /** One-way hash of the API credential, or null for self-hosted. */
  accountId: string | null;
  /** Consumer attribution label for per-consumer cost breakdown. Default: 'unspecified'. */
  consumerLabel: string;
  /** Total tokens consumed by this embed() call. */
  tokens: number;
  /** USD cost for this call. */
  costUsd: number;
  /** Billing model — used to decide whether to decrement SubscriptionLedger. */
  billingModel: EmbeddingBillingModel;
}
