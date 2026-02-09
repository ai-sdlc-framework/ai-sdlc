/**
 * JSONL file-based audit sink.
 * Appends audit entries as JSON lines to a file, providing
 * durable, tamper-evident audit log persistence.
 * <!-- Source: PRD Section 11 -->
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import type { AuditEntry, AuditSink } from './types.js';
import { computeEntryHash } from './logger.js';

/**
 * Create an append-only JSONL file sink.
 * Each audit entry is serialized as a single JSON line.
 */
export function createFileSink(filePath: string): AuditSink {
  return {
    write(entry: AuditEntry): void {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(filePath, line, 'utf-8');
    },
  };
}

/**
 * Load audit entries from a JSONL file.
 * Returns an empty array if the file does not exist.
 */
export function loadEntriesFromFile(filePath: string): AuditEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Verify the integrity of a JSONL audit file.
 * Walks the hash chain and recomputes each entry's hash.
 */
export function verifyFileIntegrity(filePath: string): { valid: boolean; brokenAt?: number } {
  const entries = loadEntriesFromFile(filePath);
  if (entries.length === 0) return { valid: true };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const expectedPrevHash = i > 0 ? entries[i - 1].hash : undefined;

    if (entry.previousHash !== expectedPrevHash) {
      return { valid: false, brokenAt: i };
    }

    const recomputed = computeEntryHash(entry, expectedPrevHash);
    if (entry.hash !== recomputed) {
      return { valid: false, brokenAt: i };
    }
  }

  return { valid: true };
}

/**
 * Rotate an audit log file by renaming it with a timestamp suffix
 * and creating a fresh empty file.
 */
export function rotateAuditFile(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rotatedPath = `${filePath}.${timestamp}`;
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf-8');
    writeFileSync(rotatedPath, content, 'utf-8');
    writeFileSync(filePath, '', 'utf-8');
  }
  return rotatedPath;
}
