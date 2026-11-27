/**
 * The one ingest write path (AISDLC-1456, DEC-0443): a new entry is `create`d, an existing
 * one is re-ingested with `write(id, { kind: 'reingest' })`, which replaces its fields.
 */
import type { KnowledgeStore, StoreScope, WriteResult } from './knowledge-store.js';

/** Counts every ingest result carries besides its own. */
export interface IngestWriteCounts {
  created: number;
  updated: number;
  /** Writes the backend queued as a proposal instead of applying. */
  proposed: number;
  /** Writes the backend rejected; nothing changed for those entries. */
  rejected: number;
}

export function emptyIngestCounts(): IngestWriteCounts {
  return { created: 0, updated: 0, proposed: 0, rejected: 0 };
}

/** Create the entry, or re-ingest it when `exists`; awaits the store and returns its result. */
export function ingestEntry(
  store: KnowledgeStore,
  entry: { fields: Record<string, unknown>; body: string },
  opts: { scope: StoreScope; path: string; principal: string; exists: boolean },
): Promise<WriteResult> {
  if (!opts.exists) {
    return store.create(entry, { scope: opts.scope, path: opts.path, principal: opts.principal });
  }
  return store.write(
    String(entry.fields.id),
    { kind: 'reingest', fields: entry.fields, body: entry.body, principal: opts.principal },
    { scope: opts.scope },
  );
}

/** Add one result to the counts; `report` receives a line for each rejection. */
export function countIngestWrite(
  counts: IngestWriteCounts,
  r: WriteResult,
  report: (line: string) => void,
): void {
  if (r.status === 'rejected' || r.status === 'conflict') {
    counts.rejected++;
    report(`rejected ${r.id}: ${r.reason ?? 'no reason given'}`);
  } else if (r.status === 'proposed') counts.proposed++;
  else if (r.created) counts.created++;
  else counts.updated++;
}
