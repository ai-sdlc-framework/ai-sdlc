/**
 * Embedding storage backend factory per RFC-0019 §8.3 + Phase 2.
 *
 * Factory is keyed on `Pipeline.spec.embedding.storageBackend` (the
 * 'storageBackend' string from pipeline config). Currently supports:
 *   - 'jsonl' (default): JSONL append-only backend at <artifactsDir>/_embeddings/
 *
 * Future backends ('sqlite', 'pgvector', 'qdrant', etc.) implement the
 * EmbeddingStorageBackend interface and register themselves here.
 *
 * Usage:
 *   const backend = createEmbeddingStorageBackend('jsonl', '/path/to/artifacts');
 */

export type { EmbeddingStorageBackend, VectorStoreEntry, VectorStoreFilter } from './types.js';
export {
  JsonlEmbeddingStorageBackend,
  SCALE_ESCALATION_MAX_ENTRIES,
  SCALE_ESCALATION_P95_READ_MS,
} from './jsonl-backend.js';
export type { ScaleEscalationSignal } from './jsonl-backend.js';

import { JsonlEmbeddingStorageBackend } from './jsonl-backend.js';
import type { EmbeddingStorageBackend } from './types.js';
import type { ScaleEscalationSignal } from './jsonl-backend.js';

/**
 * Known storage backend names.
 * Extend this union when adding new backends.
 */
export type StorageBackendName = 'jsonl' | (string & Record<never, never>);

/**
 * Options passed to the backend factory.
 */
export interface StorageBackendOptions {
  /**
   * Optional scale-escalation callback. Called when the backend detects
   * that it is approaching operational limits (>100K entries OR p95 read >250ms).
   * Wire to your telemetry layer; defaults to console.warn inside the backend.
   */
  onScaleEscalation?: (signal: ScaleEscalationSignal) => void;
}

/**
 * Create an EmbeddingStorageBackend from a backend name + artifacts directory.
 *
 * @param backendName - Backend identifier from Pipeline.spec.embedding.storageBackend.
 *   Defaults to 'jsonl' when omitted or undefined.
 * @param artifactsDir - Path to the artifacts directory. The backend creates its
 *   subdirectory (e.g., `_embeddings/`) under this path.
 * @param options - Optional factory options.
 *
 * @throws {Error} When `backendName` is not a known backend.
 *
 * @example
 *   const backend = createEmbeddingStorageBackend('jsonl', process.env.ARTIFACTS_DIR ?? '.ai-sdlc');
 *   await backend.write({ ... });
 */
export function createEmbeddingStorageBackend(
  backendName: StorageBackendName = 'jsonl',
  artifactsDir: string,
  options?: StorageBackendOptions,
): EmbeddingStorageBackend {
  switch (backendName) {
    case 'jsonl':
      return new JsonlEmbeddingStorageBackend(artifactsDir, {
        onScaleEscalation: options?.onScaleEscalation,
      });

    default:
      throw new Error(
        `Unknown embedding storage backend '${backendName}'. ` +
          `Known backends: ['jsonl']. ` +
          `To add a custom backend, implement EmbeddingStorageBackend and add a case here.`,
      );
  }
}
