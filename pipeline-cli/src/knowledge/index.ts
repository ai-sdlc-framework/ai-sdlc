/**
 * Public surface of the knowledge-store seam (AISDLC-1422), published as
 * `@ai-sdlc/pipeline-cli/knowledge` so that a `knowledge.backendModule` package can type-check
 * against `KnowledgeStore` and register a backend (RFC-0053 amendment, DEC-0427).
 *
 * Only the seam is exported: the store contract, the entry and event shapes it carries, and
 * the backend registry. Ingest, promotion and retrieval stay internal.
 */
export type { KnowledgeEntry, KnowledgeRelation, Scope } from './entry.js';
export type { KnowledgeEvent, KnowledgeEventKind } from './log.js';
export {
  KnowledgeBackendError,
  openKnowledgeStore,
  registerKnowledgeBackend,
  type GetOptions,
  type KnowledgeBackendFactory,
  type KnowledgeBackendRegistry,
  type KnowledgeBackendSelection,
  type KnowledgeRoots,
  type KnowledgeStore,
  type KnowledgeStoreRoots,
  type ListScope,
  type PutOptions,
  type PutResult,
  type RawStoredEntry,
  type StoreScope,
  type StoredEntry,
} from './knowledge-store.js';
