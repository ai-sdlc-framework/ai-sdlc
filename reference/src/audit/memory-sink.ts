/**
 * In-memory audit sink for testing.
 * Stores audit entries in an array with query and rotate support.
 */

import type { AuditEntry, AuditFilter, AuditSink } from './types.js';

export interface InMemoryAuditSink extends AuditSink {
  /** Get all stored entries (for testing). */
  getEntries(): readonly AuditEntry[];
  /** Get the count of stored entries (for testing). */
  getEntryCount(): number;
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
 * Create an in-memory audit sink for testing.
 */
export function createInMemoryAuditSink(): InMemoryAuditSink {
  let entries: AuditEntry[] = [];
  let closed = false;

  return {
    write(entry: AuditEntry): void {
      if (closed) throw new Error('AuditSink is closed');
      entries.push(entry);
    },

    async query(filter: AuditFilter): Promise<readonly AuditEntry[]> {
      if (closed) throw new Error('AuditSink is closed');
      return entries.filter((e) => matchesFilter(e, filter));
    },

    async rotate(): Promise<void> {
      entries = [];
    },

    async close(): Promise<void> {
      closed = true;
    },

    getEntries(): readonly AuditEntry[] {
      return entries;
    },

    getEntryCount(): number {
      return entries.length;
    },
  };
}
