/**
 * SQLite-backed audit sink using the state store's audit_entries table.
 * Provides indexed queries by actor, action, resource, and time range.
 */

import type { AuditEntry, AuditFilter, AuditSink } from '@ai-sdlc/reference';
import type { StateStore } from './state/index.js';

/**
 * Create an audit sink that persists entries to the SQLite state store.
 */
export function createSqliteAuditSink(store: StateStore): AuditSink {
  return {
    write(entry: AuditEntry): void {
      store.saveAuditEntry({
        entryId: entry.id,
        actor: entry.actor,
        action: entry.action,
        resourceType: entry.resource.split('/')[0],
        resourceId: entry.resource,
        detail: entry.details ? JSON.stringify(entry.details) : undefined,
        hash: entry.hash,
        previousHash: entry.previousHash,
        createdAt: entry.timestamp,
      });
    },

    async query(filter: AuditFilter): Promise<readonly AuditEntry[]> {
      const records = store.queryAuditEntries({
        actor: filter.actor,
        action: filter.action,
        resourceType: filter.resource?.split('/')[0],
        since: filter.from,
        until: filter.to,
      });

      return records
        .filter((r) => {
          if (filter.resource && r.resourceId !== filter.resource) return false;
          return true;
        })
        .map((r) => ({
          id: r.entryId,
          timestamp: r.createdAt ?? '',
          actor: r.actor,
          action: r.action,
          resource: r.resourceId ?? r.resourceType ?? '',
          decision: 'allowed' as const,
          details: r.detail ? JSON.parse(r.detail) : undefined,
          hash: r.hash,
          previousHash: r.previousHash,
        }));
    },
  };
}
