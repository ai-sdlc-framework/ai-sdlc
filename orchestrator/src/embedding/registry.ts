/**
 * Embedding adapter registry per RFC-0019 §6.1.
 *
 * Mirrors the HarnessRegistry pattern from orchestrator/src/harness/registry.ts.
 * Pipeline-load calls getEmbeddingAdapter(name) to resolve the configured provider;
 * fails fast with UnknownEmbeddingProvider when the name is not registered.
 *
 * The singleton EMBEDDING_ADAPTERS map is the registry. Adopters who need to
 * register custom adapters should call registerEmbeddingAdapter() before
 * pipeline-load resolves the embedding section.
 */

import type { EmbeddingAdapter } from './types.js';
import { UnknownEmbeddingProvider } from './errors.js';
import { OpenAITextEmbedding3Small } from './adapters/openai-text-embedding-3-small.js';

const EMBEDDING_ADAPTERS = new Map<string, EmbeddingAdapter>([
  ['openai-text-embedding-3-small', new OpenAITextEmbedding3Small()],
]);

/**
 * Resolve an embedding adapter by its canonical name.
 *
 * Throws UnknownEmbeddingProvider when the name is not in the registry.
 * Pipeline-load MUST fail with this error so operator typos are caught
 * at load time, not silently at the first embed() call site.
 *
 * @param name - Canonical adapter alias (e.g., 'openai-text-embedding-3-small').
 */
export function getEmbeddingAdapter(name: string): EmbeddingAdapter {
  const adapter = EMBEDDING_ADAPTERS.get(name);
  if (!adapter) {
    throw new UnknownEmbeddingProvider(name, [...EMBEDDING_ADAPTERS.keys()]);
  }
  return adapter;
}

/**
 * Register a custom embedding adapter. Adopters call this before pipeline-load
 * to extend the built-in registry with their own adapter implementations.
 *
 * Overwrites any existing adapter with the same name — intentional to support
 * adopter forks that want to replace the default OpenAI adapter.
 *
 * @param adapter - Adapter instance implementing EmbeddingAdapter.
 */
export function registerEmbeddingAdapter(adapter: EmbeddingAdapter): void {
  EMBEDDING_ADAPTERS.set(adapter.name, adapter);
}

/**
 * Check whether a named adapter is registered (without throwing).
 * Useful for conditional feature-flag checks at pipeline-load.
 *
 * @param name - Canonical adapter alias.
 */
export function hasEmbeddingAdapter(name: string): boolean {
  return EMBEDDING_ADAPTERS.has(name);
}

/**
 * List all registered adapter names.
 * Used in error messages and capability introspection.
 */
export function listEmbeddingAdapters(): string[] {
  return [...EMBEDDING_ADAPTERS.keys()];
}
