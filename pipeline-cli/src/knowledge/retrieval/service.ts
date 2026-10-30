/** Glue between config, the entries on disk, the adapter registry and the session ledger. */
import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadKnowledgeConfig, loadRetrievalConfig } from '../config.js';
import { harnessRecallHits } from '../ingest-memory.js';
import { readEntries } from '../store.js';
import {
  compactLedger,
  ensureLedger,
  loadedKeys,
  loadedSources,
  recordLoaded,
  resetLedger,
} from './ledger.js';
import { createRetrievalIndex } from './registry.js';
import { loadKey, type Embedder, type QueryHit, type QueryOptions } from './types.js';

function abs(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

function open(projectRoot: string, embedder?: Embedder) {
  const cfg = loadRetrievalConfig(projectRoot);
  const indexPath = abs(projectRoot, cfg.indexPath);
  // Resolve the adapter first so an unimplemented kind fails before touching disk.
  return { index: createRetrievalIndex(cfg.adapter, { indexPath, embedder }), indexPath };
}

/** Rebuild the index file from the entries in both knowledge roots. Returns entry count. */
export async function rebuildIndex(projectRoot: string, embedder?: Embedder): Promise<number> {
  const k = loadKnowledgeConfig(projectRoot);
  const entries = [
    ...readEntries(abs(projectRoot, k.trackedRoot)),
    ...readEntries(abs(projectRoot, k.protectedRoot)),
  ].filter((e) => !e.superseded);
  const cfg = loadRetrievalConfig(projectRoot);
  const indexPath = abs(projectRoot, cfg.indexPath);
  // Non-sqlite kinds throw here (enterprise: declared, not implemented) before any file is touched.
  if (cfg.adapter !== 'sqlite') createRetrievalIndex(cfg.adapter, { indexPath, embedder });
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${indexPath}${suffix}`, { force: true });
  const fresh = open(projectRoot, embedder).index;
  try {
    return await fresh.rebuild(entries);
  } finally {
    fresh.close();
  }
}

export interface QueryRequest extends QueryOptions {
  text: string;
  sessionId?: string;
  /** Injection moment recorded in the ledger (for example session-start, prompt). */
  moment?: string;
}

export async function queryIndex(
  projectRoot: string,
  req: QueryRequest,
  embedder?: Embedder,
): Promise<QueryHit[]> {
  const { index } = open(projectRoot, embedder);
  try {
    if (req.sessionId) ensureLedger(projectRoot, req.sessionId);
    const exclude = req.sessionId ? loadedKeys(projectRoot, req.sessionId) : undefined;
    const excludeSources = req.sessionId ? loadedSources(projectRoot, req.sessionId) : undefined;
    const hits = await index.query(req.text, { ...req, exclude, excludeSources });
    if (req.sessionId) recordLoaded(projectRoot, req.sessionId, hits, { moment: req.moment });
    return hits;
  } finally {
    index.close();
  }
}

/**
 * The harness recall path surfaced these memory notes: mark them loaded so the engine does not
 * inject them again. Notes already in the ledger are not recorded twice.
 */
export function recordHarnessRecall(
  projectRoot: string,
  sessionId: string,
  memoryDir: string,
  files: string[],
): number {
  ensureLedger(projectRoot, sessionId);
  const seen = loadedKeys(projectRoot, sessionId);
  const hits = harnessRecallHits(memoryDir, files).filter(
    (h) => !seen.has(loadKey(h.id, h.contentHash)),
  );
  recordLoaded(projectRoot, sessionId, hits, { moment: 'harness-recall' });
  return hits.length;
}

/** `/clear`: the session starts again with only the pre-marked entries loaded. */
export function resetSession(projectRoot: string, sessionId: string): void {
  resetLedger(projectRoot, sessionId);
}

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * `PreCompact`: an entry stays loaded when its id or its value text appears in the compaction
 * summary; the rest become eligible for injection again.
 */
export function compactSession(
  projectRoot: string,
  sessionId: string,
  summary: string,
): { kept: number; dropped: number } {
  const k = loadKnowledgeConfig(projectRoot);
  const text = squash(summary);
  const values = new Map<string, string>();
  for (const e of [
    ...readEntries(abs(projectRoot, k.trackedRoot)),
    ...readEntries(abs(projectRoot, k.protectedRoot)),
  ]) {
    values.set(e.id, squash(e.value));
  }
  return compactLedger(projectRoot, sessionId, (row) => {
    const value = values.get(row.id);
    return text.includes(row.id.toLowerCase()) || (!!value && text.includes(value));
  });
}
