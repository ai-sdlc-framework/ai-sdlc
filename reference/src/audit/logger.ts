/**
 * Append-only audit log with optional external sink.
 * Entries are frozen after creation to ensure immutability.
 */

import type { AuditEntry, AuditFilter, AuditLog, AuditSink } from './types.js';

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

export function createAuditLog(sink?: AuditSink): AuditLog {
  const log: AuditEntry[] = [];

  return {
    record(partial: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditEntry {
      const entry: AuditEntry = Object.freeze({
        id: generateId(),
        timestamp: partial.timestamp ?? new Date().toISOString(),
        actor: partial.actor,
        action: partial.action,
        resource: partial.resource,
        policy: partial.policy,
        decision: partial.decision,
        details: partial.details,
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
  };
}
