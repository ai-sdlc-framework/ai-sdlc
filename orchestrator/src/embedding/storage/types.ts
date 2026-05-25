/**
 * EmbeddingStorageBackend interface per RFC-0019 §8.3.
 *
 * Pluggable storage substrate for vector embeddings. The default implementation
 * is JSONL (shipped here); adopters MAY swap in sqlite, pgvector, Qdrant, etc.
 * by implementing this interface and wiring it via the backend factory.
 *
 * The interface is intentionally minimal — reads, writes, scans, deletes,
 * and counts. Higher-level semantics (provenance enforcement, stale-vector
 * policy, GC orchestration) live in the consumers, not the backend.
 */

/**
 * Stale-vector policy per RFC-0019 OQ-2 re-walkthrough. Defines the
 * behaviour when a vector is read but is stale relative to the adapter's
 * current `(provider, modelVersion)`. Consumers MAY pin a stricter
 * value at the API site (e.g., RFC-0009 Eτ_tessellation_drift pins
 * `'fail-loud'` regardless of org default).
 */
export type EmbeddingStaleVectorPolicy = 'lazy-re-embed' | 'fail-loud' | 'warn';

/**
 * A single stored vector entry per RFC-0019 §8.1.
 *
 * Both `embeddingProvider` and `embeddingModelVersion` MUST be set on every
 * write. Reads that find entries without these fields should be treated as
 * legacy/corrupt and deleted by the next GC pass.
 */
export interface VectorStoreEntry {
  /** The embedding vector. Length MUST equal the adapter's `dimensions`. */
  vector: number[];

  /**
   * Canonical adapter name at write time per RFC-0019 §2.3.
   * Example: 'openai-text-embedding-3-small'.
   * Part of the vector's identity — cross-provider comparisons are invalid.
   */
  embeddingProvider: string;

  /**
   * Adapter model version at write time per RFC-0019 §2.3.
   * Example: '2024-01-25' (OpenAI snapshot date).
   * Used to detect cross-version stale vectors for re-embed.
   */
  embeddingModelVersion: string;

  /**
   * ISO 8601 timestamp when this entry was written.
   * Used by mtime-based GC — entries older than gcRetentionDays are removed.
   */
  writtenAt: string;

  /**
   * Original source text (REQUIRED).
   * Needed for re-embed during migration (cli-embedding-bump).
   * Storing the text adds disk overhead but keeps migration tractable.
   */
  text: string;

  /**
   * SHA-256 hash of `text` — used as the lookup key for read-side dedup.
   * Computing hash on every lookup is wasteful; storing it eliminates the cost.
   * Also usable for content-addressable storage layouts.
   */
  textHash: string;

  /**
   * Adopter-defined metadata. Opaque to the framework.
   * Examples: { sourceDoc: 'rfc-0009.md', shardId: 'OQ-6' }
   */
  metadata?: Record<string, unknown>;
}

/**
 * Filter object for scan() and count() operations.
 * All fields are optional; absent = match all.
 */
export interface VectorStoreFilter {
  /** Restrict to entries from this embedding provider. */
  provider?: string;
  /** Restrict to entries from this model version. */
  modelVersion?: string;
}

/**
 * Pluggable storage backend interface per RFC-0019 §8.3.
 *
 * The default implementation is JSONL (JsonlEmbeddingStorageBackend).
 * Adopters who need indexed lookups beyond JSONL's linear-scan capability
 * (rough threshold: >100K entries per provider+version, or p95 read >250ms)
 * should swap in a sqlite or vector-DB backend.
 */
export interface EmbeddingStorageBackend {
  /**
   * Canonical backend name.
   * Built-in names: 'jsonl'.
   * Adopter backends should use a unique name (e.g., 'sqlite', 'pgvector').
   */
  readonly name: string;

  /**
   * Write an entry to the store.
   *
   * Implementations MUST be safe to call concurrently from multiple async
   * contexts. JSONL backend uses atomic append semantics (write-temp-rename).
   *
   * @param entry - The entry to write.
   */
  write(entry: VectorStoreEntry): Promise<void>;

  /**
   * Read an entry by textHash + provider + modelVersion triple.
   * Returns null when no matching entry exists.
   *
   * JSONL backend: O(n) linear scan — acceptable up to ~100K entries.
   *
   * @param textHash - SHA-256 hash of the source text.
   * @param provider - Adapter name (e.g., 'openai-text-embedding-3-small').
   * @param modelVersion - Adapter model version (e.g., '2024-01-25').
   */
  read(textHash: string, provider: string, modelVersion: string): Promise<VectorStoreEntry | null>;

  /**
   * Scan all entries matching an optional filter.
   * Returns an async iterator yielding one entry at a time.
   * Implementations MUST yield in the order entries appear in the store.
   *
   * @param filter - Optional filter; absent fields match all.
   */
  scan(filter?: VectorStoreFilter): AsyncIterable<VectorStoreEntry>;

  /**
   * Delete a specific entry by textHash + provider + modelVersion triple.
   * No-op when the entry does not exist.
   *
   * @param textHash - SHA-256 hash of the source text.
   * @param provider - Adapter name.
   * @param modelVersion - Adapter model version.
   */
  delete(textHash: string, provider: string, modelVersion: string): Promise<void>;

  /**
   * Count entries matching an optional filter.
   * Used by the scale-escalation heuristic — emits operator signal at >100K.
   *
   * @param filter - Optional filter; absent fields match all.
   */
  count(filter?: VectorStoreFilter): Promise<number>;
}
