export type { AuditEntry, AuditFilter, AuditSink, AuditLog, IntegrityResult } from './types.js';
export { createAuditLog, computeEntryHash } from './logger.js';
export {
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
} from './file-sink.js';
export { createInMemoryAuditSink, type InMemoryAuditSink } from './memory-sink.js';
export { createSignedAuditLog, signEntry, verifySignature } from './signed-logger.js';
export type {
  SigningKey,
  SignedAuditEntry,
  SignedAuditLog,
  SignedIntegrityResult,
} from './signed-logger.js';
