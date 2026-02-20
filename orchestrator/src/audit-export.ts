/**
 * Audit trail export — JSON, CSV, JSONL formats with filter support.
 */

import type { AuditEntry, AuditFilter, AuditLog } from '@ai-sdlc/reference';

export type ExportFormat = 'json' | 'csv' | 'jsonl';

export interface ExportOptions {
  /** Output format. */
  format: ExportFormat;
  /** Optional filter to apply before export. */
  filter?: AuditFilter;
  /** Include hash/integrity fields in output (defaults to true). */
  includeIntegrity?: boolean;
}

export interface ComplianceReportOptions {
  /** Report title. */
  title: string;
  /** Audit log to report on. */
  auditLog: AuditLog;
  /** Filter entries for the report period. */
  filter?: AuditFilter;
  /** Include integrity verification result. */
  verifyIntegrity?: boolean;
}

export interface ComplianceReport {
  title: string;
  generatedAt: string;
  entryCount: number;
  actorSummary: Record<string, number>;
  actionSummary: Record<string, number>;
  decisionSummary: Record<string, number>;
  integrityResult?: { valid: boolean; brokenAt?: number };
  entries: AuditEntry[];
}

/**
 * Export audit entries to the specified format.
 */
export function exportAuditEntries(entries: readonly AuditEntry[], options: ExportOptions): string {
  const includeIntegrity = options.includeIntegrity ?? true;

  const filtered = options.filter
    ? entries.filter((e) => matchesFilter(e, options.filter!))
    : entries;

  switch (options.format) {
    case 'json':
      return JSON.stringify(
        filtered.map((e) => formatEntry(e, includeIntegrity)),
        null,
        2,
      );

    case 'jsonl':
      return filtered.map((e) => JSON.stringify(formatEntry(e, includeIntegrity))).join('\n');

    case 'csv': {
      const headers = includeIntegrity
        ? ['id', 'timestamp', 'actor', 'action', 'resource', 'decision', 'hash', 'previousHash']
        : ['id', 'timestamp', 'actor', 'action', 'resource', 'decision'];
      const rows = filtered.map((e) =>
        headers.map((h) => csvEscape(String(e[h as keyof AuditEntry] ?? ''))).join(','),
      );
      return [headers.join(','), ...rows].join('\n');
    }

    default:
      throw new Error(`Unsupported format: ${options.format}`);
  }
}

/**
 * Generate a compliance-ready audit report.
 */
export function generateComplianceReport(options: ComplianceReportOptions): ComplianceReport {
  const allEntries = options.auditLog.entries();
  const filtered = options.filter
    ? allEntries.filter((e) => matchesFilter(e, options.filter!))
    : allEntries;

  const actorSummary: Record<string, number> = {};
  const actionSummary: Record<string, number> = {};
  const decisionSummary: Record<string, number> = {};

  for (const entry of filtered) {
    actorSummary[entry.actor] = (actorSummary[entry.actor] ?? 0) + 1;
    actionSummary[entry.action] = (actionSummary[entry.action] ?? 0) + 1;
    decisionSummary[entry.decision] = (decisionSummary[entry.decision] ?? 0) + 1;
  }

  const report: ComplianceReport = {
    title: options.title,
    generatedAt: new Date().toISOString(),
    entryCount: filtered.length,
    actorSummary,
    actionSummary,
    decisionSummary,
    entries: [...filtered],
  };

  if (options.verifyIntegrity) {
    const result = options.auditLog.verifyIntegrity();
    report.integrityResult = { valid: result.valid, brokenAt: result.brokenAt };
  }

  return report;
}

// ── Helpers ───────────────────────────────────────────────────────

function matchesFilter(entry: AuditEntry, filter: AuditFilter): boolean {
  if (filter.actor && entry.actor !== filter.actor) return false;
  if (filter.action && entry.action !== filter.action) return false;
  if (filter.resource && entry.resource !== filter.resource) return false;
  if (filter.decision && entry.decision !== filter.decision) return false;
  if (filter.from && entry.timestamp < filter.from) return false;
  if (filter.to && entry.timestamp > filter.to) return false;
  return true;
}

function formatEntry(entry: AuditEntry, includeIntegrity: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: entry.id,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    decision: entry.decision,
  };
  if (entry.details) base.details = entry.details;
  if (entry.policy) base.policy = entry.policy;
  if (includeIntegrity) {
    base.hash = entry.hash;
    base.previousHash = entry.previousHash;
  }
  return base;
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
