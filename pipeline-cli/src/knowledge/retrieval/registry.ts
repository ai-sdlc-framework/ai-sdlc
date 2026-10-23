import type { Embedder, RetrievalIndex } from './types.js';
import { HashedEmbedder } from './embedder.js';
import { SqliteRetrievalIndex } from './sqlite-index.js';

export const KNOWN_ADAPTERS = ['sqlite', 'enterprise'] as const;

export class RetrievalAdapterError extends Error {}

export interface AdapterOptions {
  indexPath: string;
  embedder?: Embedder;
}

/** Fails closed: `enterprise` is declared but not implemented, unknown kinds are rejected. */
export function createRetrievalIndex(kind: string, opts: AdapterOptions): RetrievalIndex {
  if (kind === 'sqlite') {
    return new SqliteRetrievalIndex(opts.indexPath, opts.embedder ?? new HashedEmbedder());
  }
  if (kind === 'enterprise') {
    throw new RetrievalAdapterError(
      "retrieval adapter 'enterprise' is declared but not implemented; set retrieval.adapter to 'sqlite'",
    );
  }
  throw new RetrievalAdapterError(
    `unknown retrieval adapter '${kind}' (known: ${KNOWN_ADAPTERS.join(', ')})`,
  );
}
