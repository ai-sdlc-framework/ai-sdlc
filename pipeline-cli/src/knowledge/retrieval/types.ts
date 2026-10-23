/**
 * Retrieval layer contract (RFC-0053 OQ-2). The SQLite adapter is the default;
 * an `enterprise` adapter is declared in the registry but not implemented.
 */
import type { KnowledgeEntry } from '../entry.js';

/**
 * Structural subset of the RFC-0019 `EmbeddingAdapter` (`orchestrator/src/embedding/types.ts`).
 * pipeline-cli stays orchestrator-free, so any RFC-0019 adapter satisfies this shape.
 */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface QueryOptions {
  /** Maximum total tokens of the returned entries. Default: unlimited. */
  budget?: number;
  /** Minimum normalised relevance (0..1). Default 0. */
  minScore?: number;
  /** Maximum number of results before budget trimming. Default 20. */
  limit?: number;
  /** Entries to skip: `${id}@${contentHash}` keys already loaded in the session. */
  exclude?: ReadonlySet<string>;
}

export interface QueryHit {
  id: string;
  contentHash: string;
  /** Normalised reciprocal-rank-fusion score in (0, 1]. */
  score: number;
  /** Where the claim came from: the entry's `source`. */
  citations: string[];
  tokens: number;
}

export interface RetrievalIndex {
  readonly kind: string;
  /** Replace the index contents with the given entries (rebuild from source of truth). */
  rebuild(entries: KnowledgeEntry[]): Promise<number>;
  query(text: string, opts?: QueryOptions): Promise<QueryHit[]>;
  /** Ids reachable from `id` over typed edges, up to `depth` hops (recursive CTE). */
  related(id: string, depth?: number): string[];
  close(): void;
}

export function loadKey(id: string, contentHash: string): string {
  return `${id}@${contentHash}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
