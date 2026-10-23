/** Glue between config, the entries on disk, the adapter registry and the session ledger. */
import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadKnowledgeConfig, loadRetrievalConfig } from '../config.js';
import { readEntries } from '../store.js';
import { loadedKeys, recordLoaded } from './ledger.js';
import { createRetrievalIndex } from './registry.js';
import type { Embedder, QueryHit, QueryOptions } from './types.js';

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
  ];
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
}

export async function queryIndex(
  projectRoot: string,
  req: QueryRequest,
  embedder?: Embedder,
): Promise<QueryHit[]> {
  const { index } = open(projectRoot, embedder);
  try {
    const exclude = req.sessionId ? loadedKeys(projectRoot, req.sessionId) : undefined;
    const hits = await index.query(req.text, { ...req, exclude });
    if (req.sessionId) recordLoaded(projectRoot, req.sessionId, hits);
    return hits;
  } finally {
    index.close();
  }
}
