/**
 * Append-only audit log with optional external sink.
 * Entries are frozen after creation to ensure immutability.
 * Hash chain provides tamper-evident integrity verification (PRD Section 11).
 */

import { createHash } from 'node:crypto';
import type { AuditEntry, AuditFilter, AuditLog, AuditSink, IntegrityResult } from './types.js';

let counter = 0;

function generateId(): string {
  return `audit-${Date.now()}-${++counter}`;
}

function matchesFilter(entry: AuditEntry, filter: AuditFilter): boolean {
  if (filter.actor && entry.actor !== filter.actor) return false;
  if (filter.action && entry.action !== filter.action) return false;
  if (filter.resource && entry.resource !== filter.resource) return false;
  if (filter.decision && entry.decision !== filter.decision) return false;
  if (filter.from && entry.timestamp < filter.from) return false;
  if (filter.to && entry.timestamp > filter.to) return false;
  return true;
}

/**
 * Compute a SHA-256 hash for an audit entry, chaining to the previous hash.
 * The hash covers all content fields plus the previousHash, excluding the hash field itself.
 */
export function computeEntryHash(entry: Omit<AuditEntry, 'hash'>, previousHash?: string): string {
  const payload = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    policy: entry.policy,
    decision: entry.decision,
    details: entry.details,
    previousHash: previousHash ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function createAuditLog(sink?: AuditSink): AuditLog {
  const log: AuditEntry[] = [];

  return {
    record(partial: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditEntry {
      const prevHash = log.length > 0 ? log[log.length - 1].hash : undefined;

      const base = {
        id: generateId(),
        timestamp: partial.timestamp ?? new Date().toISOString(),
        actor: partial.actor,
        action: partial.action,
        resource: partial.resource,
        policy: partial.policy,
        decision: partial.decision,
        details: partial.details,
        previousHash: prevHash,
      };

      const hash = computeEntryHash(base, prevHash);

      const entry: AuditEntry = Object.freeze({
        ...base,
        hash,
      });

      log.push(entry);
      if (sink) {
        sink.write(entry);
      }
      return entry;
    },

    entries(): readonly AuditEntry[] {
      return log;
    },

    query(filter: AuditFilter): readonly AuditEntry[] {
      return log.filter((e) => matchesFilter(e, filter));
    },

    verifyIntegrity(): IntegrityResult {
      if (log.length === 0) return { valid: true };

      for (let i = 0; i < log.length; i++) {
        const entry = log[i];
        const expectedPrevHash = i > 0 ? log[i - 1].hash : undefined;

        // Verify chain link
        if (entry.previousHash !== expectedPrevHash) {
          return { valid: false, brokenAt: i };
        }

        // Recompute and verify entry hash
        const recomputed = computeEntryHash(entry, expectedPrevHash);
        if (entry.hash !== recomputed) {
          return { valid: false, brokenAt: i };
        }
      }

      return { valid: true };
    },
  };
}
