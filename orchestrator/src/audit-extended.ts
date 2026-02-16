/**
 * Extended audit integration — covers file-based persistence, integrity
 * verification, rotation, and hash computation from the reference audit module.
 */

import {
  computeEntryHash,
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
  createAuditLog,
  type AuditEntry,
  type AuditFilter,
  type AuditSink,
  type AuditLog,
  type IntegrityResult,
} from '@ai-sdlc/reference';

/**
 * Create a file-backed audit log with integrity verification.
 */
export function createFileAuditLog(filePath: string): AuditLog {
  const sink = createFileSink(filePath);
  return createAuditLog(sink);
}

/**
 * Verify the integrity of an audit log file (hash chain verification).
 */
export async function verifyAuditIntegrity(filePath: string): Promise<IntegrityResult> {
  return verifyFileIntegrity(filePath);
}

/**
 * Load all audit entries from a file for querying/analysis.
 */
export async function loadAuditEntries(filePath: string): Promise<AuditEntry[]> {
  return loadEntriesFromFile(filePath);
}

/**
 * Rotate an audit log file (archive and create new).
 */
export async function rotateAuditLog(filePath: string): Promise<string> {
  return rotateAuditFile(filePath);
}

/**
 * Compute a SHA-256 hash for an audit entry (for manual chain building).
 */
export function computeAuditHash(entry: AuditEntry, previousHash?: string): string {
  return computeEntryHash(entry, previousHash);
}

export {
  computeEntryHash,
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
  createAuditLog,
};

export type { AuditEntry, AuditFilter, AuditSink, AuditLog, IntegrityResult };
