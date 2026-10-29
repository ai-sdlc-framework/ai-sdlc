/**
 * SQLite RetrievalIndex (RFC-0053 OQ-2): FTS5/BM25 keyword table, brute-force vector
 * table, typed edges table (recursive CTEs), fused with reciprocal rank fusion.
 * The file is derived data; `rebuild` recreates it from the entries on disk.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KnowledgeEntry } from '../entry.js';
import { tokenize } from './embedder.js';
import {
  estimateTokens,
  loadKey,
  type Embedder,
  type QueryHit,
  type QueryOptions,
  type RetrievalIndex,
} from './types.js';

export const RRF_K = 60;
const SIGNAL_DEPTH = 50;
const DEFAULT_LIMIT = 20;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, text);
  CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, vec BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, type TEXT NOT NULL, dst TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
  CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
`;

/** Reciprocal rank fusion over ranked id lists; returns id -> raw score. */
export function fuseRanks(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

function entryText(e: KnowledgeEntry): string {
  return [e.id, e.trunk, e.type, e.value, e.body].join('\n');
}

function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

export class SqliteRetrievalIndex implements RetrievalIndex {
  readonly kind = 'sqlite';
  private readonly db: Database.Database;
  private vectorCache: { ids: string[]; vecs: Float32Array[] } | null = null;

  constructor(
    readonly path: string,
    private readonly embedder: Embedder,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  async rebuild(entries: KnowledgeEntry[]): Promise<number> {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const vectors = await Promise.all(sorted.map((e) => this.embedder.embed(entryText(e))));
    const insEntry = this.db.prepare('INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?)');
    const insFts = this.db.prepare('INSERT INTO entries_fts (id, text) VALUES (?, ?)');
    const insVec = this.db.prepare('INSERT OR REPLACE INTO vectors VALUES (?, ?)');
    const insEdge = this.db.prepare('INSERT INTO edges VALUES (?, ?, ?)');
    this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM entries; DELETE FROM entries_fts; DELETE FROM vectors; DELETE FROM edges;',
      );
      sorted.forEach((e, i) => {
        const text = entryText(e);
        insEntry.run(e.id, e.contentHash, e.source, estimateTokens(text));
        insFts.run(e.id, text);
        insVec.run(e.id, toBlob(vectors[i]));
        for (const r of e.relations) insEdge.run(e.id, r.type, r.target);
        if (e.supersedes) insEdge.run(e.id, 'supersedes', e.supersedes);
      });
    })();
    this.vectorCache = null;
    return sorted.length;
  }

  private keywordRank(text: string): string[] {
    const terms = [...new Set(tokenize(text))];
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const rows = this.db
      .prepare(
        'SELECT id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY bm25(entries_fts), id LIMIT ?',
      )
      .all(match, SIGNAL_DEPTH) as { id: string }[];
    return rows.map((r) => r.id);
  }

  private loadVectors(): { ids: string[]; vecs: Float32Array[] } {
    if (this.vectorCache) return this.vectorCache;
    const rows = this.db.prepare('SELECT id, vec FROM vectors ORDER BY id').all() as {
      id: string;
      vec: Buffer;
    }[];
    this.vectorCache = {
      ids: rows.map((r) => r.id),
      vecs: rows.map(
        (r) =>
          new Float32Array(
            r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength),
          ),
      ),
    };
    return this.vectorCache;
  }

  private async vectorRank(text: string): Promise<string[]> {
    const q = await this.embedder.embed(text);
    const { ids, vecs } = this.loadVectors();
    const scored: { id: string; sim: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      let dot = 0;
      const v = vecs[i];
      for (let j = 0; j < q.length; j++) dot += q[j] * v[j];
      if (dot > 0) scored.push({ id: ids[i], sim: dot });
    }
    scored.sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1));
    return scored.slice(0, SIGNAL_DEPTH).map((s) => s.id);
  }

  /** Head of the supersedes chain containing `id` (follows incoming edges upward). */
  private chainHead(id: string): string {
    const row = this.db
      .prepare(
        `WITH RECURSIVE up(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT e.src, up.depth + 1 FROM edges e JOIN up ON e.dst = up.id
             WHERE e.type = 'supersedes' AND up.depth < 64
         )
         SELECT id FROM up ORDER BY depth DESC, id LIMIT 1`,
      )
      .get(id) as { id: string };
    return row.id;
  }

  async query(text: string, opts: QueryOptions = {}): Promise<QueryHit[]> {
    const keyword = this.keywordRank(text);
    const vector = await this.vectorRank(text);
    const fused = fuseRanks([keyword, vector]);
    // A document found by one signal at rank 1 scores 1/(k+1); both signals: 2/(k+1).
    const max = 2 / (RRF_K + 1);

    // Prefer the head of a supersedes chain: hand a superseded entry's score to its head.
    const byHead = new Map<string, number>();
    for (const [id, raw] of fused) {
      const head = this.chainHead(id);
      byHead.set(head, Math.max(byHead.get(head) ?? 0, raw));
    }
    const ranked = [...byHead].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

    const get = this.db.prepare(
      'SELECT id, content_hash, source, tokens FROM entries WHERE id = ?',
    );
    const hits: QueryHit[] = [];
    let used = 0;
    const minScore = opts.minScore ?? 0;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    for (const [id, raw] of ranked) {
      if (hits.length >= limit) break;
      const score = Math.min(1, raw / max);
      if (score < minScore) break;
      const row = get.get(id) as
        { id: string; content_hash: string; source: string; tokens: number } | undefined;
      if (!row) continue;
      if (opts.exclude?.has(loadKey(row.id, row.content_hash))) continue;
      if (opts.excludeSources?.has(row.source)) continue;
      if (opts.budget !== undefined && used + row.tokens > opts.budget) break;
      used += row.tokens;
      hits.push({
        id: row.id,
        contentHash: row.content_hash,
        score: Math.round(score * 1e6) / 1e6,
        citations: [row.source],
        tokens: row.tokens,
      });
    }
    return hits;
  }

  related(id: string, depth = 2): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE walk(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT e.dst, walk.depth + 1 FROM edges e JOIN walk ON e.src = walk.id WHERE walk.depth < ?
         )
         SELECT DISTINCT id FROM walk WHERE id != ? ORDER BY id`,
      )
      .all(id, depth, id) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Table names, for tests and diagnostics. */
  tables(): string[] {
    return (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
