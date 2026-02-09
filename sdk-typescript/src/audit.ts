/**
 * Audit logging, tamper-evident hashing, and file sink.
 * Subpath: @ai-sdlc/sdk/audit
 */
export {
  createAuditLog,
  computeEntryHash,
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
  type AuditEntry,
  type AuditFilter,
  type AuditSink,
  type AuditLog,
  type IntegrityResult,
} from '@ai-sdlc/reference';
